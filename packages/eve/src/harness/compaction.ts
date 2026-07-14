import { generateText, type LanguageModel, type ModelMessage, type TelemetryOptions } from "ai";

import {
  COMPACTION_CHECKPOINT_MARKER,
  COMPACTION_PROMPT_ENVELOPE,
  createCompactionPrompt,
} from "#harness/compaction-prompt.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import type { CompactionConfig, ToolLoopHarnessConfig } from "#harness/types.js";

const COMPACTION_SUMMARY_RESERVE_TOKENS = 2_048;

/**
 * Element type of a non-string `ModelMessage.content` array.
 */
type ModelMessageContentPart = Exclude<ModelMessage["content"], string>[number];

/**
 * Rough token estimate: serialized JSON length / 4. Good enough for
 * deciding whether compaction is needed; the real token count comes back
 * from the model each step via {@link CompactionConfig.lastKnownInputTokens}.
 *
 * Accepts any JSON-serializable value so callers can apply the same heuristic
 * to whole message arrays or individual content parts on one consistent ruler.
 */
export function estimateTokens(value: unknown): number {
  return JSON.stringify(value).length / 4;
}

const COMPACTION_PROMPT_OVERHEAD_TOKENS = estimateTokens([
  { content: COMPACTION_PROMPT_ENVELOPE.system, role: "system" },
  { content: COMPACTION_PROMPT_ENVELOPE.prompt, role: "user" },
] satisfies ModelMessage[]);

/**
 * Best available input-token count: the model-reported count from the last
 * step, plus a rough character-based estimate of whatever messages have been
 * appended since.
 */
export function getInputTokenCount(
  messages: readonly ModelMessage[],
  config: CompactionConfig,
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
    return estimateTokens(messages);
  }

  return prior + estimateTokens(messages.slice(priorCount));
}

/**
 * Returns true when the message history and fixed compaction-prompt envelope
 * exceed the compaction threshold.
 */
export function shouldCompact(
  messages: readonly ModelMessage[],
  config: CompactionConfig,
): boolean {
  return (
    messages.length > 0 &&
    getInputTokenCount(messages, config) + COMPACTION_PROMPT_OVERHEAD_TOKENS > config.threshold
  );
}

/**
 * Resolves the model used to summarize older context during compaction.
 *
 * Reuses the active turn model when compaction should summarize with the same
 * reference, and resolves the authored compaction model only when configured.
 */
export async function resolveCompactionModel(input: {
  readonly compactionModelReference?: RuntimeModelReference;
  readonly model: LanguageModel;
  readonly modelReference: RuntimeModelReference;
  readonly resolveModel: ToolLoopHarnessConfig["resolveModel"];
}): Promise<{
  readonly model: LanguageModel;
  readonly providerOptions: Parameters<typeof generateText>[0]["providerOptions"];
}> {
  const reference = input.compactionModelReference ?? input.modelReference;
  const model =
    reference === input.modelReference ? input.model : await input.resolveModel(reference);

  return {
    model,
    providerOptions: reference.providerOptions as Parameters<
      typeof generateText
    >[0]["providerOptions"],
  };
}

/**
 * Compacts messages by summarizing older history and keeping only the most
 * recent messages.
 */
export async function compactMessages(
  messages: ModelMessage[],
  model: LanguageModel,
  config: CompactionConfig,
  providerOptions?: Parameters<typeof generateText>[0]["providerOptions"],
  telemetry?: TelemetryOptions,
  headers?: Record<string, string>,
  abortSignal?: AbortSignal,
): Promise<ModelMessage[]> {
  const { conversation, previousCheckpoint } = extractPreviousCheckpoint(messages);
  let keep = selectRecentWindowSize(conversation, config);

  while (true) {
    const { older, recent } = splitMessagesForCompaction(conversation, keep);
    if (older.length === 0 && previousCheckpoint === undefined) {
      return keepNonToolResultMessages(recent);
    }

    const summaryPrompt = createCompactionPrompt({ messages: older, previousCheckpoint });

    const result = await generateText({
      abortSignal,
      headers,
      model,
      prompt: summaryPrompt.prompt,
      providerOptions,
      system: summaryPrompt.system,
      telemetry: telemetry ? { ...telemetry, functionId: "eve.compaction" } : undefined,
      temperature: 0,
    });

    // Keep recent context as plain conversation: tool results are dropped (the
    // summary above already captures the older ones) and assistant tool calls
    // are stripped, so no tool_use survives without its result. The summarized
    // older region is the durable record of tool activity.
    const keptTail = keepNonToolResultMessages(recent);

    // The kept tail may be empty or trail with an assistant message; the summary
    // assistant message also precedes it. Providers that don't support assistant
    // prefill reject a request that ends on assistant content, so append a
    // synthetic user message to resume from a user turn.
    const lastKeptRole = keptTail.at(-1)?.role;
    const trailingAssistantGuard: ModelMessage[] =
      lastKeptRole === undefined || lastKeptRole === "assistant"
        ? [{ role: "user", content: "Continue." }]
        : [];

    const compacted: ModelMessage[] = [
      { content: COMPACTION_CHECKPOINT_MARKER, role: "user" },
      { content: result.text, role: "assistant" },
      ...keptTail,
      ...trailingAssistantGuard,
    ];

    if (estimateTokens(compacted) <= config.threshold || keep === 0) {
      return compacted;
    }

    keep -= 1;
  }
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

  return {
    older: messages.slice(0, -keep),
    recent: messages.slice(-keep),
  };
}
