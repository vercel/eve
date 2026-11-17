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
import type { CompactionConfig, CompactionState } from "#harness/types.js";

const KEPT_TAIL_TOKENS = 20_000;

type ModelMessageContentPart = Exclude<ModelMessage["content"], string>[number];

const COMPACTION_PROMPT_OVERHEAD_TOKENS = estimateTokens([
  { content: COMPACTION_PROMPT_ENVELOPE.system, role: "system" },
  createFrameworkUserMessage("context.compaction", COMPACTION_PROMPT_ENVELOPE.prompt),
] satisfies ModelMessage[]);

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

export function withoutPromptMeasurement(config: CompactionState): CompactionState {
  const { lastKnownInputTokens: _input, lastKnownPromptMessageCount: _count, ...rest } = config;
  return rest;
}

export function withPromptMeasurement(
  config: CompactionState,
  measured: {
    readonly inputTokens?: number;
    readonly promptMessageCount?: number;
    readonly requestEnvelopeTokens?: number;
  },
): CompactionState {
  const { requestEnvelopeTokens: _envelope, ...next } = withoutPromptMeasurement(config);
  if (measured.inputTokens === undefined || measured.promptMessageCount === undefined) return next;
  return {
    ...next,
    lastKnownInputTokens: measured.inputTokens,
    lastKnownPromptMessageCount: measured.promptMessageCount,
    ...(measured.requestEnvelopeTokens !== undefined && {
      requestEnvelopeTokens: measured.requestEnvelopeTokens,
    }),
  };
}

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

export type CompactionSummarizer = (prompt: {
  readonly messages: ModelMessage[];
  readonly system: string;
}) => Promise<string>;

interface CompactionHeuristicInput {
  readonly config: CompactionConfig;
  readonly older: readonly ModelMessage[];
  readonly previousCheckpoint: string | undefined;
  readonly recent: readonly ModelMessage[];
  readonly replay: ModelMessage | undefined;
  readonly resume: boolean;
  readonly tokenEstimateAdjustment: number;
}

type CompactionHeuristicOutcome =
  | { readonly messages: ModelMessage[]; readonly type: "within-limit" }
  | { readonly type: "insufficient" };

type CompactionHeuristic = (input: CompactionHeuristicInput) => CompactionHeuristicOutcome;

const COMPACTION_HEURISTICS: readonly CompactionHeuristic[] = [toolResultCapHeuristic];

function toolResultCapHeuristic(input: CompactionHeuristicInput): CompactionHeuristicOutcome {
  const checkpointHead: ModelMessage[] =
    input.previousCheckpoint === undefined
      ? []
      : [
          createFrameworkUserMessage("context.compaction", COMPACTION_CHECKPOINT_MARKER),
          { content: input.previousCheckpoint, role: "assistant" },
        ];
  const kept = [...checkpointHead, ...capToolResults(input.older), ...input.recent];
  const capped = input.resume ? resumeAfter(kept, input.replay, input.config.threshold) : kept;

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

export async function compactMessages(
  messages: ModelMessage[],
  config: CompactionConfig,
  summarize: CompactionSummarizer,
  forceSummary = false,
  historyInputTokenCount?: number,
  resume = true,
): Promise<ModelMessage[]> {
  const { conversation, previousCheckpoint } = extractPreviousCheckpoint(messages);
  const withResumptionGuard: typeof resumeAfter = (kept, replay, threshold) =>
    resume ? resumeAfter(kept, replay, threshold) : kept;
  const budget = keptTailBudget(config);
  const recentConfig = forceSummary ? { ...config, recentWindowSize: 1 } : config;

  const planTail = (history: readonly ModelMessage[]) => {
    const index = resume ? findLastRealUserIndex(history) : -1;
    const current = history[index];
    const fit = current === undefined ? undefined : fitCurrentMessage(current, budget);
    const replay = fit?.replay ?? current;
    let keep = selectRecentWindowSize(history, recentConfig, budget);
    if (replay !== undefined && index < history.length - keep) {
      keep = selectRecentWindowSize(
        history,
        recentConfig,
        Math.max(0, budget - estimateTokens([replay])),
      );
    }
    return { currentIndex: index, fit, keep, replay };
  };

  const first = planTail(conversation);
  if (!forceSummary && first.fit === undefined) {
    const { older, recent } = splitMessagesForCompaction(conversation, first.keep);
    if (older.length === 0 && previousCheckpoint === undefined) {
      return keepNonToolResultMessages(recent);
    }

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
        resume,
        tokenEstimateAdjustment,
      });
      if (outcome.type === "within-limit") {
        return outcome.messages;
      }
    }
  }

  const cappedConversation = capToolResults(conversation);
  const summaryPlan = planTail(cappedConversation);
  const { currentIndex, fit, keep, replay } = summaryPlan;

  const current = currentIndex < 0 ? undefined : cappedConversation[currentIndex];
  const noFiles = current === undefined ? undefined : omitFiles(current);
  const floorCut = noFiles === undefined ? undefined : fitCurrentMessage(noFiles, 1)?.replay;
  const floorRequest =
    noFiles !== undefined &&
    floorCut !== undefined &&
    estimateTokens([floorCut]) < estimateTokens([noFiles])
      ? floorCut
      : noFiles;
  const floor = withResumptionGuard(checkpointHead(""), floorRequest, Number.POSITIVE_INFINITY);
  if (evaluateThreshold(floor, config, "estimate").type === "over-limit") {
    throw new CompactionOverLimitError(
      `The agent's system prompt, tools and memory leave only ~${config.threshold} tokens for the conversation, too few to compact it.`,
    );
  }

  const { older, recent } = splitMessagesForCompaction(cappedConversation, keep);

  const summaryPrompt = createCompactionPrompt({
    messages:
      fit === undefined
        ? older
        : older.map((message, index) => (index === currentIndex ? fit.cut : message)),
    previousCheckpoint,
    transcriptBudgetTokens: config.threshold,
  });

  const summary = await summarize({
    messages: [createFrameworkUserMessage("context.compaction", summaryPrompt.prompt)],
    system: summaryPrompt.system,
  });

  const fits = (candidate: readonly ModelMessage[]) =>
    evaluateThreshold(candidate, config, "estimate").type === "within-limit";

  const verbatim = withResumptionGuard(
    [...checkpointHead(summary), ...recent],
    replay,
    config.threshold,
  );
  if (fits(verbatim)) {
    return verbatim;
  }

  const textTail = keepNonToolResultMessages(recent);
  const stripped = withResumptionGuard(
    [...checkpointHead(summary), ...textTail],
    replay,
    config.threshold,
  );
  if (fits(stripped)) {
    return stripped;
  }

  const noTail = withResumptionGuard(checkpointHead(summary), replay, config.threshold);
  if (fits(noTail)) {
    return noTail;
  }

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
    return clipped;
  }

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
  return cutRequest;
}

const CAPPED_RESULT_ANNOTATION =
  "[Truncated by eve: tool result reduced during context compaction. Re-run the tool if you need the full output.]";
const CAPPED_RESULT_PREFIX = `${CAPPED_RESULT_ANNOTATION}\n\n`;

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
          type: output.type === "error-text" ? ("error-text" as const) : ("text" as const),
          value: `${CAPPED_RESULT_PREFIX}${clipMiddleUtf16Safe(serialized, TRANSCRIPT_PAYLOAD_LIMIT - CAPPED_RESULT_PREFIX.length)}`,
        },
      };
    });

    return changed ? { ...message, content } : message;
  });
}

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

function fitCurrentMessage(
  message: ModelMessage,
  budget: number,
): { readonly cut: ModelMessage; readonly replay: ModelMessage } | undefined {
  const text = messageText(message);
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

const MIN_CLIP_CHARS = 40;

const OMITTED_FILE_NOTE =
  "[eve: a file in this message was omitted during context compaction: it is too large for the context window.]";

function checkpointHead(summary: string): ModelMessage[] {
  return [
    createFrameworkUserMessage("context.compaction", COMPACTION_CHECKPOINT_MARKER),
    { content: summary, role: "assistant" },
  ];
}

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

function messageText(message: ModelMessage): string | undefined {
  if (typeof message.content === "string") {
    return message.content;
  }
  const texts = message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
  return texts.length === 0 ? undefined : texts.join("");
}

type MessagePart = Exclude<ModelMessage["content"], string>[number];

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
