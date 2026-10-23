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

const COMPACTION_SUMMARY_RESERVE_TOKENS = 2_048;

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
  readonly calibration: Calibration;
  readonly checkpointHead: readonly ModelMessage[];
  readonly config: CompactionConfig;
  readonly conversation: readonly ModelMessage[];
  readonly older: readonly ModelMessage[];
  readonly previousCheckpoint: string | undefined;
  readonly recent: readonly ModelMessage[];
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
  const cappedOlder = capToolResults(input.older);
  const capped = withResumptionGuard(
    [...input.checkpointHead, ...cappedOlder, ...input.recent],
    input.conversation,
    input.config.threshold,
  );

  // A capped result is still measured text, only shorter, so it keeps its original's ratio.
  const measured = new Set(input.calibration.measured);
  input.older.forEach((message, index) => {
    const replacement = cappedOlder[index];
    if (replacement !== undefined && measured.has(message)) {
      measured.add(replacement);
    }
  });

  // Capping can be a near no-op when the older region holds few large
  // results; accepting one that still trips shouldCompact would let it
  // re-fire every step without compaction ever making progress.
  return fitsThreshold(capped, input.config, { ...input.calibration, measured })
    ? { messages: capped, type: "within-limit" }
    : { type: "insufficient" };
}

/**
 * How far the character estimate sits below the provider's count, learned from
 * the messages the provider last measured. It applies only to those messages
 * (by identity): a summary, a cut note or a message appended after the
 * measurement is new text the provider has not counted, so it stays at the
 * estimate.
 */
interface Calibration {
  readonly measured: Set<ModelMessage>;
  readonly scale: number;
}

function calibrate(messages: readonly ModelMessage[], config: CompactionConfig): Calibration {
  const provider = config.lastKnownInputTokens;
  const count = config.lastKnownPromptMessageCount;
  if (
    provider === undefined ||
    count === undefined ||
    !Number.isInteger(count) ||
    count <= 0 ||
    count > messages.length
  ) {
    return { measured: new Set(), scale: 1 };
  }
  const prefix = messages.slice(0, count);
  const estimated = estimateTokens(prefix);
  return {
    measured: new Set(prefix),
    scale: estimated > 0 ? Math.max(1, provider / estimated) : 1,
  };
}

function calibratedTokens(messages: readonly ModelMessage[], calibration: Calibration): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens([message]) * scaleOf(message, calibration);
  }
  return total;
}

function scaleOf(message: ModelMessage, calibration: Calibration): number {
  return calibration.measured.has(message) ? calibration.scale : 1;
}

/**
 * The one test every candidate history must pass: on the ruler
 * {@link shouldCompact} uses (fixed prompt-envelope overhead included), with
 * the provider-measured messages scaled to the provider's count. A history
 * that passes cannot re-trigger compaction on the next step.
 */
function fitsThreshold(
  messages: readonly ModelMessage[],
  config: CompactionConfig,
  calibration: Calibration,
): boolean {
  return (
    calibratedTokens(messages, calibration) + COMPACTION_PROMPT_OVERHEAD_TOKENS <= config.threshold
  );
}

/**
 * Compacts messages by escalation: try each {@link CompactionHeuristic} in
 * order, then fall back to summarizing the older region with the compaction
 * model — keeping the recent tail verbatim when it fits, degrading it to
 * text-only, then shrinking the window.
 *
 * `estimateTokens` is a character ruler and can sit well below the provider's
 * count (1.6x on URL- and JSON-heavy text). Acceptance checks therefore scale
 * the messages the provider last measured by that provider-to-estimate ratio:
 * a result accepted here must not re-trigger {@link shouldCompact} on the
 * next step. A compaction that frees nothing and stays over the threshold
 * throws, so the caller stops instead of compacting again on every step.
 */
export async function compactMessages(
  messages: ModelMessage[],
  config: CompactionConfig,
  summarize: CompactionSummarizer,
  forceSummary = false,
): Promise<ModelMessage[]> {
  const calibration = calibrate(messages, config);
  const compacted = await compactWithScale(messages, config, summarize, forceSummary, calibration);
  if (!fitsThreshold(compacted, config, calibration)) {
    const remaining = Math.round(
      calibratedTokens(compacted, calibration) + COMPACTION_PROMPT_OVERHEAD_TOKENS,
    );
    throw new CompactionOverLimitError(
      `Context compaction could not bring the conversation under its limit: it is still about ${remaining} tokens against a ${config.threshold}-token limit. Start a new session, or send a smaller message.`,
    );
  }
  return compacted;
}

async function compactWithScale(
  messages: ModelMessage[],
  config: CompactionConfig,
  summarize: CompactionSummarizer,
  forceSummary: boolean,
  calibration: Calibration,
): Promise<ModelMessage[]> {
  const { checkpointHead, conversation, previousCheckpoint } = extractPreviousCheckpoint(messages);
  const recentConfig = forceSummary ? { ...config, recentWindowSize: 1 } : config;
  let keep = selectRecentWindowSize(conversation, recentConfig);

  // A current message that alone takes most of the budget would be kept word
  // for word after every compaction, so compaction could never get under the
  // threshold. Replay only its newest part and summarize the cut-off head.
  const currentIndex = findLastRealUserIndex(conversation, hasText);
  const current = conversation[currentIndex];
  const cut =
    !fitsThreshold(conversation, config, calibration) && current !== undefined
      ? fitCurrentMessage(current, config.threshold, scaleOf(current, calibration))
      : undefined;
  const replay = cut?.replay;
  if (cut !== undefined) {
    // The replay is the measured message's newest part: it keeps that message's ratio.
    if (current !== undefined && calibration.measured.has(current)) {
      calibration.measured.add(cut.replay);
    }
    keep = Math.min(keep, conversation.length - 1 - currentIndex);
  }
  const olderToSummarize = (older: readonly ModelMessage[]): readonly ModelMessage[] =>
    cut === undefined
      ? older
      : older.map((message, index) => (index === currentIndex ? cut.head : message));

  if (!forceSummary) {
    const { older, recent } = splitMessagesForCompaction(conversation, keep);
    if (older.length === 0 && previousCheckpoint === undefined) {
      return keepNonToolResultMessages(recent);
    }

    for (const heuristic of COMPACTION_HEURISTICS) {
      const outcome = heuristic({
        calibration,
        checkpointHead,
        config,
        conversation,
        older,
        previousCheckpoint,
        recent,
      });
      if (outcome.type === "within-limit") {
        return outcome.messages;
      }
    }
  }

  while (true) {
    const { older, recent } = splitMessagesForCompaction(conversation, keep);

    const summaryPrompt = createCompactionPrompt({
      messages: olderToSummarize(older),
      previousCheckpoint,
      transcriptBudgetTokens: config.threshold / calibration.scale,
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
    const verbatim = withResumptionGuard(
      [...summaryHead, ...recent],
      conversation,
      config.threshold,
      replay,
    );
    if (fitsThreshold(verbatim, config, calibration)) {
      return verbatim;
    }

    const stripped = withResumptionGuard(
      [...summaryHead, ...keepNonToolResultMessages(recent)],
      conversation,
      config.threshold,
      replay,
    );
    if (fitsThreshold(stripped, config, calibration) || keep === 0) {
      return stripped;
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
  conversation: readonly ModelMessage[],
  threshold: number,
  fittedReplay?: ModelMessage,
): ModelMessage[] {
  const lastRole = messages.at(-1)?.role;
  const replay = fittedReplay ?? findLastRealUserMessage(conversation);
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
 * A current user message may take at most this share of the compaction
 * threshold (calibrated to the provider's count), leaving the rest for the
 * checkpoint summary, the recent tail, and the next steps' tool results.
 */
const CURRENT_MESSAGE_THRESHOLD_SHARE = 0.5;

/**
 * Splits `message` when it exceeds its share of the threshold, or returns
 * `undefined` when it already fits. `replay` keeps its newest text, behind a
 * note that the start was cut; `head` is the cut-off start, which the
 * summarizer receives in full. Non-text parts (files) stay on the replay.
 */
function fitCurrentMessage(
  message: ModelMessage,
  threshold: number,
  scale: number,
): { readonly head: ModelMessage; readonly replay: ModelMessage } | undefined {
  const text = messageText(message);
  const budget = (threshold * CURRENT_MESSAGE_THRESHOLD_SHARE) / scale;
  if (text === undefined || estimateTokens([message]) <= budget) {
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

function hasText(message: ModelMessage): boolean {
  return messageText(message) !== undefined;
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

/**
 * Latest user message authored by the user rather than the framework.
 */
function findLastRealUserMessage(conversation: readonly ModelMessage[]): ModelMessage | undefined {
  return conversation[
    findLastRealUserIndex(conversation, (message) => typeof message.content === "string")
  ];
}

function findLastRealUserIndex(
  conversation: readonly ModelMessage[],
  accepts: (message: ModelMessage) => boolean,
): number {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index];
    if (message?.role !== "user" || !accepts(message) || isFrameworkUserMessage(message)) {
      continue;
    }
    return index;
  }

  return -1;
}

function extractPreviousCheckpoint(messages: readonly ModelMessage[]): {
  readonly checkpointHead: ModelMessage[];
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
    return { checkpointHead: [], conversation: [...messages], previousCheckpoint: undefined };
  }

  return {
    checkpointHead: [marker, checkpoint],
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

function selectRecentWindowSize(
  messages: readonly ModelMessage[],
  config: CompactionConfig,
): number {
  const maxKeep = Math.min(config.recentWindowSize, Math.max(messages.length - 1, 0));
  const reserve = resolveCompactionSummaryReserve(config);
  let keep = 0;
  let recentTokens = 0;

  for (let index = messages.length - 1; index >= 0 && keep < maxKeep; index -= 1) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }

    const messageTokens = estimateTokens([message]);
    if (recentTokens + messageTokens + reserve > config.threshold) {
      break;
    }

    recentTokens += messageTokens;
    keep += 1;
  }

  return keep;
}

function resolveCompactionSummaryReserve(config: CompactionConfig): number {
  return Math.min(
    COMPACTION_SUMMARY_RESERVE_TOKENS,
    Math.max(64, Math.floor(config.threshold / 4)),
  );
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
