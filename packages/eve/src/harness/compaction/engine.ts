import type { ModelMessage } from "ai";

import {
  clipMiddleUtf16Safe,
  COMPACTION_CHECKPOINT_MARKER,
  COMPACTION_PROMPT_ENVELOPE,
  COMPACTION_RESUMPTION_MESSAGE,
  createCompactionPrompt,
  serializeToolResultOutput,
  stubContentOutputFileParts,
  TRANSCRIPT_PAYLOAD_LIMIT,
} from "#harness/compaction/prompt.js";
import { createFrameworkUserMessage, isFrameworkUserMessage } from "#harness/messages.js";
import { CompactionOverLimitError } from "#harness/compaction/over-limit-error.js";
import { estimateTokens } from "#harness/token-estimate.js";
import type { CompactionConfig } from "#harness/types.js";

/**
 * Most of the conversation kept word for word next to a compaction summary.
 * A fixed budget, not a share of the context window: the history after a
 * compaction is the summary plus at most this much, however far the character
 * estimate sits below the provider's count (about 1.6x on URL- and JSON-heavy
 * text), so the next compaction is far off.
 */
const KEPT_TAIL_TOKENS = 20_000;

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
  config: CompactionConfig,
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

  return (
    prior +
    estimateTokens(messages.slice(priorCount)) +
    Math.max(0, requestEnvelopeTokens - previousEnvelopeTokens)
  );
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

/** Conversation regions and config handed to each compaction heuristic. */
interface CompactionHeuristicInput {
  readonly config: CompactionConfig;
  readonly older: readonly ModelMessage[];
  readonly previousCheckpoint: string | undefined;
  readonly recent: readonly ModelMessage[];
  readonly replay: ModelMessage | undefined;
  readonly tokenEstimateAdjustment: number;
}

/**
 * A heuristic either produces a complete replacement history that fits the
 * threshold, or signals that the next strategy must run. Heuristics have no
 * failure channel — anything exceptional throws.
 */
type CompactionHeuristicOutcome =
  | { readonly messages: ModelMessage[]; readonly type: "within-limit" }
  | { readonly type: "insufficient" };

type CompactionHeuristic = (input: CompactionHeuristicInput) => CompactionHeuristicOutcome;

/**
 * Model-free heuristics tried in order before falling back to LLM
 * summarization. Each is a pure transformation of the split conversation;
 * composing a new strategy (pruning variants, protect-lists) means adding an
 * entry here.
 */
const COMPACTION_HEURISTICS: readonly CompactionHeuristic[] = [toolResultCapHeuristic];

/**
 * Caps oversized tool-result outputs in the older region while every message
 * — including its tool calls and the recent tail — stays structurally
 * verbatim. Most history bulk is a handful of large tool outputs, so this
 * usually suffices with no model call and no rewriting.
 */
function toolResultCapHeuristic(input: CompactionHeuristicInput): CompactionHeuristicOutcome {
  const checkpointHead: ModelMessage[] =
    input.previousCheckpoint === undefined
      ? []
      : [
          createFrameworkUserMessage("context.compaction", COMPACTION_CHECKPOINT_MARKER),
          { content: input.previousCheckpoint, role: "assistant" },
        ];
  const capped = withResumptionGuard(
    [...checkpointHead, ...capToolResults(input.older), ...input.recent],
    input.replay,
    input.config.threshold,
  );

  // Evaluate on the same ruler shouldCompact uses (envelope included):
  // capping can be a near no-op when the older region holds few large
  // results, and accepting one on a looser ruler would let shouldCompact
  // re-fire every step without compaction ever making progress.
  const evaluation = evaluateThreshold(
    capped,
    input.config,
    "should-compact",
    input.tokenEstimateAdjustment,
  );
  return evaluation.type === "within-limit"
    ? { messages: capped, type: "within-limit" }
    : { type: "insufficient" };
}

/**
 * Measures a candidate history against the compaction threshold.
 * The "should-compact" ruler includes the fixed prompt-envelope overhead that
 * {@link shouldCompact} adds, so a history accepted on it cannot immediately
 * re-trigger compaction; "estimate" is the bare history size.
 */
function evaluateThreshold(
  messages: readonly ModelMessage[],
  config: CompactionConfig,
  ruler: "estimate" | "should-compact",
  tokenEstimateAdjustment = 0,
): { readonly estimatedTokens: number; readonly type: "over-limit" | "within-limit" } {
  const overhead = ruler === "should-compact" ? COMPACTION_PROMPT_OVERHEAD_TOKENS : 0;
  const estimatedTokens = estimateTokens(messages) + overhead + tokenEstimateAdjustment;
  return {
    estimatedTokens,
    type: estimatedTokens <= config.threshold ? "within-limit" : "over-limit",
  };
}

/**
 * Compacts messages by escalation: try each {@link CompactionHeuristic} in
 * order, then fall back to summarizing the older region with the compaction
 * model — keeping the recent tail verbatim when it fits, degrading it to
 * text-only, then shrinking the window.
 */
export async function compactMessages(
  messages: ModelMessage[],
  config: CompactionConfig,
  summarize: CompactionSummarizer,
  forceSummary = false,
  historyInputTokenCount?: number,
): Promise<ModelMessage[]> {
  const { conversation, previousCheckpoint } = extractPreviousCheckpoint(messages);
  const budget = keptTailBudget(config);
  const recentConfig = forceSummary ? { ...config, recentWindowSize: 1 } : config;

  // The current request is replayed after every compaction. One over the tail
  // budget keeps only its newest part; the cut-off start goes to the summarizer.
  const planTail = (history: readonly ModelMessage[]) => {
    const index = findLastRealUserIndex(history);
    const current = history[index];
    const cut = current === undefined ? undefined : fitCurrentMessage(current, budget);
    const replay = cut?.replay ?? current;
    let keep = selectRecentWindowSize(history, recentConfig, budget);
    if (replay !== undefined && index < history.length - keep) {
      // The window leaves the request out, so it is replayed after the summary.
      keep = selectRecentWindowSize(
        history,
        recentConfig,
        Math.max(0, budget - estimateTokens([replay])),
      );
    }
    return { currentIndex: index, cut, keep, replay };
  };

  const first = planTail(conversation);
  if (!forceSummary && first.cut === undefined) {
    const { older, recent } = splitMessagesForCompaction(conversation, first.keep);
    if (older.length === 0 && previousCheckpoint === undefined) {
      return keepNonToolResultMessages(recent);
    }

    // Capping preserves most of the measured prompt. Retain any known
    // underestimate while crediting only the estimated tokens it removes.
    // A new summary replaces that prompt, so it uses its own estimate below.
    const tokenEstimateAdjustment = Math.max(
      0,
      (historyInputTokenCount ?? getInputTokenCount(messages, config)) - estimateTokens(messages),
    );
    for (const heuristic of COMPACTION_HEURISTICS) {
      const outcome = heuristic({
        config,
        older,
        previousCheckpoint,
        recent,
        replay: first.replay,
        tokenEstimateAdjustment,
      });
      if (outcome.type === "within-limit") {
        return outcome.messages;
      }
    }
  }

  // Tool results in the kept tail are shortened on this path only: one large
  // file read would otherwise take the whole tail budget.
  const cappedConversation = capToolResults(conversation);
  const summaryPlan = planTail(cappedConversation);
  const { currentIndex, cut, replay } = summaryPlan;
  let { keep } = summaryPlan;

  while (true) {
    const { older, recent } = splitMessagesForCompaction(cappedConversation, keep);

    const summaryPrompt = createCompactionPrompt({
      messages:
        cut === undefined
          ? older
          : older.map((message, index) => (index === currentIndex ? cut.head : message)),
      previousCheckpoint,
      transcriptBudgetTokens: config.threshold,
    });

    const summary = await summarize({
      messages: [createFrameworkUserMessage("context.compaction", summaryPrompt.prompt)],
      system: summaryPrompt.system,
    });

    const summaryHead: ModelMessage[] = [
      createFrameworkUserMessage("context.compaction", COMPACTION_CHECKPOINT_MARKER),
      { content: summary, role: "assistant" },
    ];

    // Prefer keeping the recent tail verbatim — surviving tool results are the
    // model's evidence that work already ran. Degrade to text-only, then to a
    // smaller window, only under threshold pressure.
    const verbatim = withResumptionGuard([...summaryHead, ...recent], replay, config.threshold);
    if (evaluateThreshold(verbatim, config, "estimate").type === "within-limit") {
      return verbatim;
    }

    const stripped = withResumptionGuard(
      [...summaryHead, ...keepNonToolResultMessages(recent)],
      replay,
      config.threshold,
    );
    const evaluation = evaluateThreshold(stripped, config, "estimate");
    if (evaluation.type === "within-limit") {
      return stripped;
    }
    if (keep === 0) {
      // Retrying would summarize the same history again: end the step with the reason.
      throw new CompactionOverLimitError(
        `Context compaction could not bring the conversation under its limit: it is still about ${Math.round(evaluation.estimatedTokens)} tokens against a ${config.threshold}-token limit. Start a new session, or send a smaller message.`,
      );
    }

    keep -= 1;
  }
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
          type: "text" as const,
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
function withResumptionGuard(
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
    if (
      lastRole === "tool" &&
      replay !== undefined &&
      !alreadyKept &&
      estimateTokens([replay]) <= threshold
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
 * Splits `message` when it exceeds the tail budget, or returns
 * `undefined` when it already fits. `replay` keeps its newest text, behind a
 * note that the start was cut; `head` is the cut-off start, which the
 * summarizer receives in full. Non-text parts (files) stay on the replay.
 */
function fitCurrentMessage(
  message: ModelMessage,
  budget: number,
): { readonly head: ModelMessage; readonly replay: ModelMessage } | undefined {
  const text = messageText(message);
  // The replay keeps the message's file parts, so when they alone take the
  // budget, cutting its text frees nothing.
  if (text === undefined || budget <= 0 || estimateTokens([message]) <= budget) {
    return undefined;
  }

  const note = (omitted: number) =>
    `[eve: the first ${omitted} characters of this message were cut during context compaction to fit the context window. Only its newest part follows.]\n\n`;
  const split = (start: number) => splitMessageText(message, start, note(start));
  let keptChars = Math.floor(budget * 4);
  while (keptChars > 0) {
    keptChars = Math.min(keptChars, text.length);
    let start = text.length - keptChars;
    const first = text.charCodeAt(start);
    if (first >= 0xdc00 && first <= 0xdfff) {
      start += 1;
    }
    const fitted = split(start);
    if (estimateTokens([fitted.replay]) <= budget) {
      return fitted;
    }
    keptChars = Math.floor(keptChars * 0.9) - 1;
  }
  return split(text.length);
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
 * Cuts the first `start` characters of {@link messageText}: `head` keeps them,
 * `replay` keeps the rest behind `note`. Non-text parts stay on both.
 */
function splitMessageText(
  message: ModelMessage,
  start: number,
  note: string,
): { readonly head: ModelMessage; readonly replay: ModelMessage } {
  if (typeof message.content === "string") {
    return {
      head: { ...message, content: message.content.slice(0, start) } as ModelMessage,
      replay: { ...message, content: `${note}${message.content.slice(start)}` } as ModelMessage,
    };
  }
  let offset = 0;
  let noted = false;
  const head: MessagePart[] = [];
  const replay: MessagePart[] = [];
  for (const part of message.content) {
    if (part.type !== "text") {
      head.push(part);
      replay.push(part);
      continue;
    }
    const cut = Math.max(0, Math.min(part.text.length, start - offset));
    offset += part.text.length;
    if (cut > 0) {
      head.push({ ...part, text: part.text.slice(0, cut) });
    }
    if (cut < part.text.length) {
      const kept = part.text.slice(cut);
      replay.push({ ...part, text: noted ? kept : `${note}${kept}` });
      noted = true;
    }
  }
  if (!noted) {
    replay.push({ type: "text", text: note });
  }
  return {
    head: { ...message, content: head } as ModelMessage,
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
  // without its preceding tool_use. Snap such messages into the older region.
  let split = messages.length - keep;
  while (split < messages.length && messages[split]?.role === "tool") {
    split += 1;
  }

  return {
    older: messages.slice(0, split),
    recent: messages.slice(split),
  };
}
