import { generateText, type LanguageModel, type ModelMessage, type TelemetryOptions } from "ai";

import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import type { CompactionConfig, ToolLoopHarnessConfig } from "#harness/types.js";

const COMPACTION_SYSTEM_PROMPT = [
  "You are a conversation summarizer.",
  "Write a concise but useful summary for continuing the work.",
  "Preserve the goal, important instructions, technical decisions, discoveries, open work, and relevant tool results.",
  "Use the same language as the conversation.",
  "Prefer short labeled sections such as Goal, Instructions, Discoveries, Accomplished, and Next steps when helpful.",
  "Do not answer questions or invent facts.",
].join(" ");

const COMPACTION_SUMMARY_RESERVE_TOKENS = 2_048;
const COMPACTION_TEXT_LIMIT = 280;
const COMPACTION_COLLECTION_LIMIT = 3;

interface CompactionTranscriptMessage {
  readonly content: string;
  readonly role: ModelMessage["role"];
}

/**
 * Element type of a non-string `ModelMessage.content` array.
 */
type ModelMessageContentPart = Exclude<ModelMessage["content"], string>[number];

/**
 * Rough token estimate: serialized JSON length / 4. Good enough for
 * deciding whether compaction is needed; the real token count comes back
 * from the model each step via {@link CompactionConfig.lastKnownInputTokens}.
 *
 * Accepts any JSON-serializable value so the reactive pruning system can
 * apply the same heuristic to individual tool-result parts — keeping
 * every layer of context management on one consistent token ruler.
 */
export function estimateTokens(value: unknown): number {
  return JSON.stringify(value).length / 4;
}

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
 * Returns true when the message history exceeds the compaction threshold.
 */
export function shouldCompact(
  messages: readonly ModelMessage[],
  config: CompactionConfig,
): boolean {
  return getInputTokenCount(messages, config) > config.threshold;
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
): Promise<ModelMessage[]> {
  let keep = selectRecentWindowSize(messages, config);

  while (true) {
    const { older, recent } = splitMessagesForCompaction(messages, keep);
    if (older.length === 0) {
      return recent;
    }

    const prunedOlder: CompactionTranscriptMessage[] = older.map((message) => ({
      content: summarizeCompactionMessageContent(message),
      role: message.role,
    }));

    const result = await generateText({
      headers,
      model,
      prompt: formatCompactionPrompt(prunedOlder),
      providerOptions,
      system: COMPACTION_SYSTEM_PROMPT,
      telemetry: telemetry ? { ...telemetry, functionId: "eve.compaction" } : undefined,
      temperature: 0,
    });

    // The recent window may trail with an assistant message (e.g.
    // deferred-input continuations where no user message was appended).
    // Providers that don't support assistant prefill reject the request.
    // Append a synthetic user message so the model resumes from a user turn.
    const trailingAssistantGuard: ModelMessage[] =
      recent.length > 0 && recent.at(-1)?.role === "assistant"
        ? [{ role: "user", content: "Continue." }]
        : [];

    const compacted: ModelMessage[] = [
      { content: "Summary of our conversation so far:", role: "user" },
      { content: result.text, role: "assistant" },
      ...recent,
      ...trailingAssistantGuard,
    ];

    if (estimateTokens(compacted) <= config.threshold || keep === 0) {
      return compacted;
    }

    keep -= 1;
  }
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

function formatCompactionPrompt(messages: readonly CompactionTranscriptMessage[]): string {
  const sections = messages
    .filter((message) => message.content.trim().length > 0)
    .map((message) => `### ${message.role}\n${message.content.trim()}`);

  if (sections.length === 0) {
    return "Summarize the conversation so far.";
  }

  return ["Conversation transcript:", ...sections].join("\n\n");
}

function summarizeCompactionMessageContent(message: ModelMessage): string {
  if (typeof message.content === "string") {
    return summarizeText(message.content);
  }

  return message.content
    .map((part) => summarizeCompactionContentPart(part))
    .filter((summary) => summary.length > 0)
    .join("\n")
    .trim();
}

function summarizeCompactionContentPart(part: ModelMessageContentPart): string {
  switch (part.type) {
    case "text":
      return summarizeText(part.text);
    case "reasoning":
      return "";
    case "file":
      return part.filename
        ? `Attached file ${part.filename} (${part.mediaType})`
        : `Attached file attachment (${part.mediaType})`;
    case "tool-call":
      return summarizeToolCallPart(part);
    case "tool-result":
      return summarizeToolResultPart(part);
    default:
      return "";
  }
}

function summarizeToolCallPart(part: { toolName: string; input?: unknown }): string {
  const input = part.input !== undefined ? summarizeCompactValue(part.input) : "";
  return input ? `Called ${part.toolName} with ${input}` : `Called ${part.toolName}`;
}

function summarizeToolResultPart(part: {
  toolName: string;
  output?: unknown;
  isError?: boolean;
}): string {
  const output = part.output !== undefined ? summarizeCompactValue(part.output) : "";
  const status = part.isError ? "errored" : "returned";
  return output ? `Tool ${part.toolName} ${status} ${output}` : `Tool ${part.toolName} ${status}`;
}

function summarizeCompactValue(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return summarizeText(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "array(0)";
    }

    if (depth >= 2) {
      return `array(${value.length})`;
    }

    const entries = value
      .slice(0, COMPACTION_COLLECTION_LIMIT)
      .map((item) => summarizeCompactValue(item, depth + 1));
    const suffix = value.length > COMPACTION_COLLECTION_LIMIT ? ", …" : "";
    return `array(${value.length}: ${entries.join(", ")}${suffix})`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return "object(0)";
    }

    if (depth >= 2) {
      return `object(${entries.length} keys)`;
    }

    const rendered = entries
      .slice(0, COMPACTION_COLLECTION_LIMIT)
      .map(([key, nested]) => `${key}=${summarizeCompactValue(nested, depth + 1)}`);
    const suffix = entries.length > COMPACTION_COLLECTION_LIMIT ? ", …" : "";
    return `object(${rendered.join(", ")}${suffix})`;
  }

  return "";
}

function summarizeText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= COMPACTION_TEXT_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, COMPACTION_TEXT_LIMIT).trimEnd()}…`;
}
