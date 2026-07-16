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
 * Providers bill a file part (image, PDF) at a roughly fixed rate on the
 * order of a thousand tokens, regardless of how long its base64 payload is.
 * Estimating file parts by serialized length instead would overcount a
 * typical screenshot by two orders of magnitude and trigger compaction on
 * content that is cheap for the model.
 */
const FILE_DATA_ESTIMATED_TOKENS = 1_600;
const FILE_DATA_ESTIMATE_PLACEHOLDER = ".".repeat(FILE_DATA_ESTIMATED_TOKENS * 4);

/** Serialization replacer: cap file-part `data` payloads at the fixed estimate. */
function capFileDataForEstimate(this: unknown, key: string, value: unknown): unknown {
  if (
    key === "data" &&
    typeof value === "string" &&
    value.length > FILE_DATA_ESTIMATE_PLACEHOLDER.length &&
    isFileDataContainer(this)
  ) {
    return FILE_DATA_ESTIMATE_PLACEHOLDER;
  }
  return value;
}

/**
 * The two shapes that carry file payloads under a `data` key: a message-level
 * file part (`{type: "file", data}`) and a tool-result content file part's
 * nested data object (`{type: "data", data}`).
 */
function isFileDataContainer(container: unknown): boolean {
  if (typeof container !== "object" || container === null) {
    return false;
  }
  const type = (container as { type?: unknown }).type;
  return type === "file" || type === "data";
}

/**
 * Rough token estimate: serialized JSON length / 4, with file-part payloads
 * capped at {@link FILE_DATA_ESTIMATED_TOKENS}. Good enough for
 * deciding whether compaction is needed; the real token count comes back
 * from the model each step via {@link CompactionConfig.lastKnownInputTokens}.
 *
 * Accepts any JSON-serializable value so callers can apply the same heuristic
 * to whole message arrays or individual content parts on one consistent ruler.
 */
export function estimateTokens(value: unknown): number {
  return JSON.stringify(value, capFileDataForEstimate).length / 4;
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
  abortSignal?: AbortSignal,
): Promise<ModelMessage[]> {
  let keep = selectRecentWindowSize(messages, config);

  while (true) {
    const { older, recent } = splitMessagesForCompaction(messages, keep);
    if (older.length === 0) {
      return keepNonToolResultMessages(recent);
    }

    const prunedOlder: CompactionTranscriptMessage[] = older.map((message) => ({
      content: summarizeCompactionMessageContent(message),
      role: message.role,
    }));

    const result = await generateText({
      abortSignal,
      headers,
      model,
      prompt: formatCompactionPrompt(prunedOlder),
      providerOptions,
      system: COMPACTION_SYSTEM_PROMPT,
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
      { content: "Summary of our conversation so far:", role: "user" },
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
  const output = part.output !== undefined ? summarizeToolResultOutput(part.output) : "";
  const status = part.isError ? "errored" : "returned";
  return output ? `Tool ${part.toolName} ${status} ${output}` : `Tool ${part.toolName} ${status}`;
}

/**
 * A content output carries the model-facing text and file parts of a tool
 * result. Summarize those like message content — file parts become the same
 * filename+mediaType stub {@link summarizeCompactionContentPart} uses — so
 * the summary keeps the text and names the file instead of reducing both to
 * an anonymous `object(N keys)` via the generic JSON walk.
 */
function summarizeToolResultOutput(output: unknown): string {
  if (
    typeof output === "object" &&
    output !== null &&
    (output as { type?: unknown }).type === "content" &&
    Array.isArray((output as { value?: unknown }).value)
  ) {
    const parts = (output as { value: readonly unknown[] }).value
      .map((part) => summarizeContentOutputPart(part))
      .filter((summary) => summary.length > 0);
    if (parts.length > 0) {
      return parts.join("; ");
    }
  }
  return summarizeCompactValue(output);
}

function summarizeContentOutputPart(part: unknown): string {
  if (typeof part !== "object" || part === null) {
    return "";
  }
  const candidate = part as {
    type?: unknown;
    text?: unknown;
    filename?: unknown;
    mediaType?: unknown;
  };
  if (candidate.type === "text" && typeof candidate.text === "string") {
    return summarizeText(candidate.text);
  }
  if (candidate.type === "file") {
    const mediaType = typeof candidate.mediaType === "string" ? candidate.mediaType : "unknown";
    return typeof candidate.filename === "string"
      ? `Attached file ${candidate.filename} (${mediaType})`
      : `Attached file attachment (${mediaType})`;
  }
  return "";
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
