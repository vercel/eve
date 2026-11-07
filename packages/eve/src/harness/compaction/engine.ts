import type { ModelMessage } from "ai";

import {
  clipMiddleUtf16Safe,
  COMPACTION_CHECKPOINT_MARKER,
  COMPACTION_PROMPT_ENVELOPE,
  COMPACTION_RESUMPTION_MESSAGE,
  createCompactionPrompt,
  serializeToolResultOutput,
  sliceUtf16Safe,
  stubContentOutputFileParts,
  TRANSCRIPT_PAYLOAD_LIMIT,
} from "#harness/compaction/prompt.js";
import { createFrameworkUserMessage, isFrameworkUserMessage } from "#harness/messages.js";
import { CompactionOverLimitError } from "#harness/compaction/over-limit-error.js";
import { awaitsProviderToolResult } from "#harness/provider-tool-history.js";
import { estimateTokens } from "#harness/token-estimate.js";
import type { CompactionConfig, CompactionStage, CompactionState } from "#harness/types.js";

/**
 * Most of the conversation kept word for word next to a compaction summary.
 * A fixed budget, not a share of the context window: the history after a
 * compaction is the summary plus at most this much, however far the character
 * estimate sits below the provider's count (about 1.6x on URL- and JSON-heavy
 * text), so the next compaction is far off.
 */
const KEPT_TAIL_TOKENS = 20_000;

/** Provider tokens per estimated token before a call is measured: the worst case above. */
const DEFAULT_ESTIMATE_RATIO = 1.6;

/** Provider tokens per estimated token in this session, from its last measured call. */
export function estimateRatio(config: CompactionState): number {
  return config.estimateRatio ?? DEFAULT_ESTIMATE_RATIO;
}

/**
 * Element type of a non-string `ModelMessage.content` array.
 */
type ModelMessageContentPart = Exclude<ModelMessage["content"], string>[number];

// Static envelope estimate stays valid because createCompactionPrompt bounds
// its transcript to the caller's threshold budget, so the summarization call
// itself never grows past threshold + envelope + checkpoint.
const COMPACTION_PROMPT_OVERHEAD_TOKENS = estimateTokens([
  { content: COMPACTION_PROMPT_ENVELOPE.system, role: "system" },
  createFrameworkUserMessage("context.compaction", COMPACTION_PROMPT_ENVELOPE.prompt),
] satisfies ModelMessage[]);

/**
 * Best available input-token count: the model-reported count from the last
 * step, plus a rough character-based estimate of whatever messages have been
 * appended since.
 */
export function getInputTokenCount(
  messages: readonly ModelMessage[],
  config: CompactionState,
  requestEnvelopeTokens = 0,
  previousEnvelopeTokens = 0,
): number {
  const prior = config.lastKnownInputTokens;
  const priorCount = config.lastKnownPromptMessageCount;

  if (
    prior === undefined ||
    priorCount === undefined ||
    !Number.isInteger(priorCount) ||
    priorCount < 0 ||
    priorCount > messages.length
  ) {
    return estimateTokens(messages) + requestEnvelopeTokens;
  }

  const appended = messages.slice(priorCount);
  return (
    prior +
    (appended.length === 0 ? 0 : estimateTokens(appended)) +
    Math.max(0, requestEnvelopeTokens - previousEnvelopeTokens)
  );
}

/** The settings without the last measured prompt, which a rewritten history no longer matches. */
export function withoutPromptMeasurement(config: CompactionState): CompactionState {
  const { lastKnownInputTokens: _input, lastKnownPromptMessageCount: _count, ...rest } = config;
  return rest;
}

/**
 * The settings with a model-reported prompt measurement and the envelope around it. Without a
 * usable measurement, the next count is an estimate, and no envelope baseline applies.
 *
 * The measurement also sets the session's estimate ratio: the provider's count over the estimate
 * of the same request. The last compaction's stage is kept through the first measured call after
 * it, so a compaction that call already triggers starts at the next stage.
 */
export function withPromptMeasurement(
  config: CompactionState,
  measured: {
    /** The character estimate of the request the provider counted: its history and envelope. */
    readonly estimatedTokens?: number;
    readonly inputTokens?: number;
    readonly promptMessageCount?: number;
    readonly requestEnvelopeTokens?: number;
  },
): CompactionState {
  const { lastStage, requestEnvelopeTokens: _envelope, ...rest } = withoutPromptMeasurement(config);
  const next: CompactionState = {
    ...rest,
    ...(lastStage !== undefined && config.lastKnownInputTokens === undefined && { lastStage }),
  };
  if (measured.inputTokens === undefined || measured.promptMessageCount === undefined) return next;
  const { estimatedTokens, inputTokens } = measured;
  return {
    ...next,
    ...(estimatedTokens !== undefined &&
      estimatedTokens > 0 &&
      inputTokens > 0 && { estimateRatio: inputTokens / estimatedTokens }),
    lastKnownInputTokens: measured.inputTokens,
    lastKnownPromptMessageCount: measured.promptMessageCount,
    ...(measured.requestEnvelopeTokens !== undefined && {
      requestEnvelopeTokens: measured.requestEnvelopeTokens,
    }),
  };
}

/**
 * Returns true when the message history and fixed compaction-prompt envelope
 * exceed the compaction threshold.
 */
export function shouldCompact(
  messages: readonly ModelMessage[],
  config: CompactionConfig,
  requestEnvelopeTokens = 0,
  previousEnvelopeTokens = 0,
): boolean {
  return (
    messages.length > 0 &&
    getInputTokenCount(messages, config, requestEnvelopeTokens, previousEnvelopeTokens) +
      COMPACTION_PROMPT_OVERHEAD_TOKENS >
      config.threshold
  );
}

/** Summarizes one compaction prompt with the compaction model, returning the summary text. */
export type CompactionSummarizer = (prompt: {
  readonly messages: ModelMessage[];
  readonly system: string;
}) => Promise<string>;

/**
 * Measures a candidate history against the compaction threshold on the bare
 * character estimate: the limit the fallbacks must fit before the call is sent.
 */
function evaluateThreshold(
  messages: readonly ModelMessage[],
  config: CompactionConfig,
): { readonly estimatedTokens: number; readonly type: "over-limit" | "within-limit" } {
  const estimatedTokens = estimateTokens(messages);
  return {
    estimatedTokens,
    type: estimatedTokens <= config.threshold ? "within-limit" : "over-limit",
  };
}

/** The stage a compaction starts at: the one after a stage whose result was over the trigger. */
function startStage(lastStage: CompactionStage | undefined): CompactionStage {
  if (lastStage === undefined) return "tail";
  return lastStage === "tail" ? "text-tail" : "summary-only";
}

/**
 * Compacts messages by summarizing them with the compaction model, keeping the
 * recent tail verbatim when the result reaches the target, degrading it to text-only, then
 * dropping it, clipping the summary and cutting the request until it fits the threshold. A
 * compaction whose result was already over the trigger on the next call starts at the stage
 * after the one it ended at. Returns the history and the stage it ended at.
 */
export async function compactMessages(
  messages: ModelMessage[],
  config: CompactionConfig,
  summarize: CompactionSummarizer,
  forceSummary = false,
  /**
   * Whether a request is waiting on the next model call. Between turns every request has its
   * answer, and the next turn's input follows the summary: nothing is replayed or prompted.
   */
  resume = true,
): Promise<{ readonly messages: ModelMessage[]; readonly stage: CompactionStage }> {
  const { conversation, previousCheckpoint } = extractPreviousCheckpoint(messages);
  const withResumptionGuard: typeof resumeAfter = (kept, replay, threshold) =>
    resume ? resumeAfter(kept, replay, threshold) : kept;
  const budget = keptTailBudget(config);
  const recentConfig = forceSummary ? { ...config, recentWindowSize: 1 } : config;

  // The current request is replayed after every compaction. One over the tail
  // budget keeps its start and end; the cut-out middle goes to the summarizer.
  const planTail = (history: readonly ModelMessage[]) => {
    const index = resume ? findLastRealUserIndex(history) : -1;
    const current = history[index];
    const fit = current === undefined ? undefined : fitCurrentMessage(current, budget);
    const replay = fit?.replay ?? current;
    let keep = selectRecentWindowSize(history, recentConfig, budget);
    if (replay !== undefined && index < history.length - keep) {
      // The window leaves the request out, so it is replayed after the summary.
      keep = selectRecentWindowSize(
        history,
        recentConfig,
        Math.max(0, budget - estimateTokens([replay])),
      );
    }
    return { currentIndex: index, fit, keep, replay };
  };

  const start = startStage(config.lastStage);
  const first = planTail(conversation);
  if (!forceSummary && start === "tail" && first.fit === undefined) {
    const { older, recent } = splitMessagesForCompaction(conversation, first.keep);
    if (older.length === 0 && previousCheckpoint === undefined) {
      return { messages: keepNonToolResultMessages(recent), stage: "text-tail" };
    }
  }

  // Tool results in the kept tail are shortened on this path only: one large
  // file read would otherwise take the whole tail budget.
  const cappedConversation = capToolResults(conversation);
  const summaryPlan = planTail(cappedConversation);
  const { currentIndex, fit, keep, replay } = summaryPlan;

  const current = currentIndex < 0 ? undefined : cappedConversation[currentIndex];
  const noFiles = current === undefined ? undefined : omitFiles(current);
  // The least a compaction can be: the checkpoint and the request, or its cut to a note if that is shorter.
  const floorCut = noFiles === undefined ? undefined : fitCurrentMessage(noFiles, 1)?.replay;
  const floorRequest =
    noFiles !== undefined &&
    floorCut !== undefined &&
    estimateTokens([floorCut]) < estimateTokens([noFiles])
      ? floorCut
      : noFiles;
  const floor = withResumptionGuard(checkpointHead(""), floorRequest, Number.POSITIVE_INFINITY);
  if (evaluateThreshold(floor, config).type === "over-limit") {
    throw new CompactionOverLimitError(
      `The agent's system prompt, tools and memory leave only ~${config.threshold} tokens for the conversation, too few to compact it.`,
    );
  }

  const { recent } = splitMessagesForCompaction(cappedConversation, keep);

  // The summary reads the tail too: the target can drop its tool results or all of it, and
  // what is dropped must survive in the summary.
  const summaryPrompt = createCompactionPrompt({
    messages:
      fit === undefined
        ? cappedConversation
        : cappedConversation.map((message, index) => (index === currentIndex ? fit.cut : message)),
    previousCheckpoint,
    transcriptBudgetTokens: config.threshold,
  });

  const summary = await summarize({
    messages: [createFrameworkUserMessage("context.compaction", summaryPrompt.prompt)],
    system: summaryPrompt.system,
  });

  const fits = (candidate: readonly ModelMessage[]) =>
    evaluateThreshold(candidate, config).type === "within-limit";
  // The tail stages must reach the target on the provider's ruler, far enough under the trigger
  // that the next steps' output doesn't compact again at once.
  const ratio = estimateRatio(config);
  const reachesTarget = (candidate: readonly ModelMessage[]) =>
    Math.ceil(estimateTokens(candidate) * ratio) <= config.target;

  // Prefer keeping the recent tail verbatim — surviving tool results are the
  // model's evidence that work already ran. Degrade to text-only, then drop
  // the tail, then clip the summary, then cut the request: never summarize
  // again, since a smaller tail does not make the summary smaller.
  if (start === "tail") {
    const verbatim = withResumptionGuard(
      [...checkpointHead(summary), ...recent],
      replay,
      config.threshold,
    );
    if (reachesTarget(verbatim)) {
      return { messages: verbatim, stage: "tail" };
    }
  }

  if (start !== "summary-only") {
    const textTail = keepNonToolResultMessages(recent);
    const stripped = withResumptionGuard(
      [...checkpointHead(summary), ...textTail],
      replay,
      config.threshold,
    );
    if (reachesTarget(stripped)) {
      return { messages: stripped, stage: "text-tail" };
    }
  }

  const noTail = withResumptionGuard(checkpointHead(summary), replay, config.threshold);
  if (fits(noTail)) {
    return { messages: noTail, stage: "summary-only" };
  }

  // Last, the summary is clipped to the largest piece that fits beside the
  // request; undefined when the request leaves it no room at all.
  const withClippedSummary = (request: ModelMessage | undefined): ModelMessage[] | undefined => {
    const build = (chars: number) =>
      withResumptionGuard(
        checkpointHead(
          chars < MIN_CLIP_CHARS
            ? sliceUtf16Safe(summary, chars)
            : clipMiddleUtf16Safe(summary, chars),
        ),
        request,
        config.threshold,
      );
    if (!fits(build(0))) {
      return undefined;
    }
    let low = 0;
    let high = summary.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(build(mid))) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return build(low);
  };

  const clipped = withClippedSummary(replay);
  if (clipped !== undefined) {
    return { messages: clipped, stage: "summary-only" };
  }

  // The request itself is over: a file it carries gives way to a note first,
  // then its text is cut to the room that is left.
  const requestBudget =
    config.threshold -
    estimateTokens(withResumptionGuard(checkpointHead(""), undefined, config.threshold));
  const request =
    noFiles === undefined
      ? undefined
      : (fitCurrentMessage(noFiles, requestBudget)?.replay ?? noFiles);
  const cutRequest = withClippedSummary(request);
  if (cutRequest === undefined) {
    throw new CompactionOverLimitError(
      `The agent's system prompt, tools and memory leave only ~${config.threshold} tokens for the conversation, too few to compact it.`,
    );
  }
  return { messages: cutRequest, stage: "summary-only" };
}

const CAPPED_RESULT_ANNOTATION =
  "[Truncated by eve: tool result reduced during context compaction. Re-run the tool if you need the full output.]";
const CAPPED_RESULT_PREFIX = `${CAPPED_RESULT_ANNOTATION}\n\n`;

/**
 * Caps oversized tool-result outputs in place, keeping message structure and
 * tool_use/tool_result pairing untouched. The cap matches the transcript
 * payload clip, so a later summarization sees the same content the model
 * kept — capping never destroys material the summarizer would need, unlike
 * dropping results outright. The cap keeps the head and tail of the output,
 * where failures and exit codes usually are.
 *
 * Capping is idempotent: the capped value, annotation included, fits the
 * same limit it was measured against, and a text output is measured by its
 * value, so a later compaction leaves an already-capped part as it is.
 */
function capToolResults(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool" || typeof message.content === "string") {
      return message;
    }

    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") {
        return part;
      }
      // File parts of a content output reduce to their text stubs before the
      // size check: serializing raw payloads into a prefix cap would keep
      // bytes the model cannot read while cutting the text it can.
      const output = stubContentOutputFileParts(part.output) as typeof part.output;
      const serialized = serializeToolResultOutput(output);
      if (serialized.length <= TRANSCRIPT_PAYLOAD_LIMIT) {
        if (output === part.output) {
          return part;
        }
        changed = true;
        return { ...part, output };
      }

      changed = true;
      return {
        ...part,
        output: {
          // A capped failure stays a failure for the model.
          type: output.type === "error-text" ? ("error-text" as const) : ("text" as const),
          value: `${CAPPED_RESULT_PREFIX}${clipMiddleUtf16Safe(serialized, TRANSCRIPT_PAYLOAD_LIMIT - CAPPED_RESULT_PREFIX.length)}`,
        },
      };
    });

    return changed ? { ...message, content } : message;
  });
}

/**
 * Providers that don't support assistant prefill reject a request that ends on
 * assistant content, so compaction must resume from a user turn. Rather than
 * a contentless framework prompt, replay the conversation's last real user
 * message when compaction folded it away — the model resumes against its
 * actual instruction, with the checkpoint as background. Falls back to
 * "Continue." when the last real user message still survives in the kept
 * messages (the model was mid-work on it) or none exists.
 */
function resumeAfter(
  messages: ModelMessage[],
  replay: ModelMessage | undefined,
  threshold: number,
): ModelMessage[] {
  const lastRole = messages.at(-1)?.role;
  const alreadyKept =
    replay !== undefined &&
    messages.some((message) => message.role === "user" && message.content === replay.content);

  if (lastRole !== undefined && lastRole !== "assistant") {
    // A retained tool tail must not displace a task that can fit in the budget.
    // Including it here lets tail selection make room before accepting a candidate.
    // A provider tool's pending result must directly follow the tail, so nothing joins it.
    if (
      lastRole === "tool" &&
      replay !== undefined &&
      !alreadyKept &&
      estimateTokens([replay]) <= threshold &&
      !awaitsProviderToolResult(messages)
    ) {
      return [...messages, replay];
    }
    return messages;
  }

  return [
    ...messages,
    replay !== undefined && !alreadyKept
      ? replay
      : createFrameworkUserMessage("execution.continuation", COMPACTION_RESUMPTION_MESSAGE),
  ];
}

/**
 * Splits `message` when it exceeds the tail budget, or returns `undefined`
 * when it already fits. `replay` keeps the start (a fifth of the budget) and
 * the end of its text, behind a note where the middle was cut; `cut` is that
 * middle, which the summarizer receives in full. Instructions sit at the
 * start or the end of a request and bulk pasted text in the middle. Non-text
 * parts (files) stay on the replay.
 */
function fitCurrentMessage(
  message: ModelMessage,
  budget: number,
): { readonly cut: ModelMessage; readonly replay: ModelMessage } | undefined {
  const text = messageText(message);
  // The replay keeps the message's file parts, so when they alone take the
  // budget, cutting its text frees nothing.
  if (text === undefined || budget <= 0 || estimateTokens([message]) <= budget) {
    return undefined;
  }

  const note = (omitted: number) =>
    `\n\n[eve: ${omitted} characters from the middle of this message were cut during context compaction to fit the context window.]\n\n`;
  const split = (start: number, end: number) =>
    splitMessageText(message, start, end, note(end - start));
  let keptChars = Math.floor(budget * 4);
  while (keptChars > 0) {
    keptChars = Math.min(keptChars, text.length);
    const lead = Math.floor(keptChars * 0.2);
    const start = sliceUtf16Safe(text, lead).length;
    let end = text.length - (keptChars - lead);
    const after = text.charCodeAt(end);
    if (after >= 0xdc00 && after <= 0xdfff) {
      end += 1;
    }
    if (start < end) {
      const fitted = split(start, end);
      if (estimateTokens([fitted.replay]) <= budget) {
        return fitted;
      }
    }
    keptChars = Math.floor(keptChars * 0.9) - 1;
  }
  return split(0, text.length);
}

/** Below this the clip marker would not fit: the summary keeps only its start. */
const MIN_CLIP_CHARS = 40;

const OMITTED_FILE_NOTE =
  "[eve: a file in this message was omitted during context compaction: it is too large for the context window.]";

function checkpointHead(summary: string): ModelMessage[] {
  return [
    createFrameworkUserMessage("context.compaction", COMPACTION_CHECKPOINT_MARKER),
    { content: summary, role: "assistant" },
  ];
}

/** Replaces every non-text part of a message with one note. */
function omitFiles(message: ModelMessage): ModelMessage {
  if (typeof message.content === "string") {
    return message;
  }
  const parts: MessagePart[] = [];
  let noted = false;
  for (const part of message.content) {
    if (part.type === "text") {
      parts.push(part);
    } else if (!noted) {
      noted = true;
      parts.push({ type: "text", text: OMITTED_FILE_NOTE });
    }
  }
  return noted ? ({ ...message, content: parts } as ModelMessage) : message;
}

/** The text a user message can be cut by: its string content, or its text parts joined in order. */
function messageText(message: ModelMessage): string | undefined {
  if (typeof message.content === "string") {
    return message.content;
  }
  const texts = message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
  return texts.length === 0 ? undefined : texts.join("");
}

type MessagePart = Exclude<ModelMessage["content"], string>[number];

/**
 * Cuts characters `start` to `end` of {@link messageText}: `cut` keeps only
 * that middle, `replay` keeps the rest with `note` at the cut. Non-text parts
 * stay on both.
 */
function splitMessageText(
  message: ModelMessage,
  start: number,
  end: number,
  note: string,
): { readonly cut: ModelMessage; readonly replay: ModelMessage } {
  if (typeof message.content === "string") {
    return {
      cut: { ...message, content: message.content.slice(start, end) } as ModelMessage,
      replay: {
        ...message,
        content: `${message.content.slice(0, start)}${note}${message.content.slice(end)}`,
      } as ModelMessage,
    };
  }
  let offset = 0;
  let noted = false;
  const cutParts: MessagePart[] = [];
  const replay: MessagePart[] = [];
  for (const part of message.content) {
    if (part.type !== "text") {
      cutParts.push(part);
      replay.push(part);
      continue;
    }
    const from = Math.max(0, Math.min(part.text.length, start - offset));
    const to = Math.max(from, Math.min(part.text.length, end - offset));
    offset += part.text.length;
    if (to > from) {
      cutParts.push({ ...part, text: part.text.slice(from, to) });
    }
    const before = part.text.slice(0, from);
    const after = part.text.slice(to);
    const cutHere: boolean = to > from && !noted;
    if (cutHere) {
      noted = true;
    }
    const text = `${before}${cutHere ? note : ""}${after}`;
    if (text.length > 0) {
      replay.push({ ...part, text });
    }
  }
  if (!noted) {
    replay.push({ type: "text", text: note });
  }
  return {
    cut: { ...message, content: cutParts } as ModelMessage,
    replay: { ...message, content: replay } as ModelMessage,
  };
}

function findLastRealUserIndex(conversation: readonly ModelMessage[]): number {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index];
    if (message?.role === "user" && !isFrameworkUserMessage(message)) {
      return index;
    }
  }

  return -1;
}

function extractPreviousCheckpoint(messages: readonly ModelMessage[]): {
  readonly conversation: ModelMessage[];
  readonly previousCheckpoint: string | undefined;
} {
  const marker = messages[0];
  const checkpoint = messages[1];
  if (
    marker?.role !== "user" ||
    marker.content !== COMPACTION_CHECKPOINT_MARKER ||
    checkpoint?.role !== "assistant"
  ) {
    return { conversation: [...messages], previousCheckpoint: undefined };
  }

  return {
    conversation: messages.slice(2),
    previousCheckpoint: assistantMessageText(checkpoint),
  };
}

/**
 * Returns the kept tail for a compacted history: recent messages with tool
 * activity removed. Tool-result messages are dropped, and assistant messages are
 * reduced to their text content (tool-call and reasoning parts stripped) so the
 * rebuilt history never carries a tool_use without its matching result.
 * Assistant messages with no remaining text are dropped; user messages are kept
 * verbatim.
 */
function keepNonToolResultMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  const kept: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "tool") {
      continue;
    }

    if (message.role === "assistant") {
      const text = assistantMessageText(message);
      if (text.length > 0) {
        kept.push({ content: text, role: "assistant" });
      }
      continue;
    }

    kept.push(message);
  }

  return kept;
}

/**
 * Concatenated text content of an assistant message, ignoring tool-call,
 * reasoning, and other non-text parts.
 */
function assistantMessageText(message: ModelMessage): string {
  if (typeof message.content === "string") {
    return message.content.trim();
  }

  return message.content
    .filter(
      (part): part is Extract<ModelMessageContentPart, { type: "text" }> => part.type === "text",
    )
    .map((part) => part.text)
    .join("")
    .trim();
}

function keptTailBudget(config: CompactionConfig): number {
  return Math.min(KEPT_TAIL_TOKENS, Math.floor(config.threshold / 2));
}

function selectRecentWindowSize(
  messages: readonly ModelMessage[],
  config: CompactionConfig,
  budget: number,
): number {
  const maxKeep = Math.min(config.recentWindowSize, Math.max(messages.length - 1, 0));
  let keep = 0;
  let recentTokens = 0;

  for (let index = messages.length - 1; index >= 0 && keep < maxKeep; index -= 1) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }

    const messageTokens = estimateTokens([message]);
    if (recentTokens + messageTokens > budget) {
      break;
    }

    recentTokens += messageTokens;
    keep += 1;
  }

  return keep;
}

function splitMessagesForCompaction(
  messages: readonly ModelMessage[],
  keep: number,
): {
  readonly older: ModelMessage[];
  readonly recent: ModelMessage[];
} {
  if (keep <= 0) {
    return {
      older: [...messages],
      recent: [],
    };
  }

  // The recent tail survives verbatim, so it must not open with tool results
  // whose tool calls fall in the older region — providers reject a tool_result
  // without its preceding tool_use. Snap such messages into the older region,
  // including a response that opens with a deferred provider tool result.
  let split = messages.length - keep;
  while (split < messages.length && opensWithEarlierResult(messages[split]!)) {
    split += 1;
  }

  return {
    older: messages.slice(0, split),
    recent: messages.slice(split),
  };
}

function opensWithEarlierResult(message: ModelMessage): boolean {
  if (message.role === "tool") return true;
  if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
  const calls = new Set(
    message.content.flatMap((part) => (part.type === "tool-call" ? [part.toolCallId] : [])),
  );
  return message.content.some((part) => part.type === "tool-result" && !calls.has(part.toolCallId));
}
