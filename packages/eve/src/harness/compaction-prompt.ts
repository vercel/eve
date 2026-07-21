import type { ModelMessage } from "ai";

import { estimateTokens } from "#harness/token-estimate.js";

export const COMPACTION_CHECKPOINT_MARKER = "Summary of our conversation so far:";

const COMPACTION_SYSTEM_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:

- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done, with clear next steps
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work. Write in the same language as the conversation. Do not continue the conversation, answer its questions, or invent facts. Only output the handoff summary.`;

const COMPACTION_CHECKPOINT_PROMPT = `Update the previous checkpoint with the newer information in the conversation. If there is no previous checkpoint, create one from the conversation.

Make completed work explicit so the next model does not repeat it. Keep completed work separate from current and remaining work, and do not describe completed work as pending unless later messages show it must be redone. Preserve exact file paths, function names, commands, error messages, identifiers, and measured values when they are needed to continue.`;

// Applies only to strings inside tool inputs/outputs. Conversational
// user/assistant text reaches the summarizer verbatim: a delegated task
// message truncated here is unrecoverable after the first compaction, while
// tool payloads stay useful as a compact call trail.
const COMPACTION_TOOL_TEXT_LIMIT = 280;
const COMPACTION_COLLECTION_LIMIT = 3;

// Fallback cap for conversational text, applied oldest-first only when the
// rendered transcript exceeds the caller's token budget.
const DEGRADED_TEXT_LIMIT = 2_000;

interface CompactionTranscriptEntry {
  readonly content: string;
  readonly role: ModelMessage["role"];
}

export interface CompactionPrompt {
  readonly prompt: string;
  readonly system: string;
}

/** Static prompt text added around checkpoint and conversation content. */
export const COMPACTION_PROMPT_ENVELOPE = {
  prompt: formatCompactionPrompt({ previousCheckpoint: "", transcript: "" }),
  system: COMPACTION_SYSTEM_PROMPT,
} satisfies CompactionPrompt;

/**
 * Builds the compaction model input from framework-owned checkpoint state and
 * older messages.
 *
 * Conversational text is rendered verbatim. When `transcriptBudgetTokens` is
 * set and the rendered prompt exceeds it, conversational text is capped at
 * {@link DEGRADED_TEXT_LIMIT} starting from the oldest entries until the
 * prompt fits; the previous checkpoint is never truncated.
 */
export function createCompactionPrompt(input: {
  readonly messages: readonly ModelMessage[];
  readonly previousCheckpoint: string | undefined;
  readonly transcriptBudgetTokens?: number;
}): CompactionPrompt {
  const entries = input.messages.map((message) => ({
    content: renderCompactionMessageContent(message),
    role: message.role,
  }));

  degradeOversizedTranscript(input, entries);

  return {
    prompt: formatCompactionPrompt({
      previousCheckpoint: input.previousCheckpoint?.trim() ?? "(none)",
      transcript: formatCompactionTranscript(entries),
    }),
    system: COMPACTION_SYSTEM_PROMPT,
  };
}

/**
 * Re-renders the oldest entries with degraded (capped) conversational text
 * until the estimated prompt fits the budget. Mutates `entries` in place.
 * Savings are tracked per entry instead of re-estimating the whole prompt per
 * iteration; the char-length delta divided by 4 matches the
 * {@link estimateTokens} ruler closely enough for a soft budget.
 */
function degradeOversizedTranscript(
  input: {
    readonly messages: readonly ModelMessage[];
    readonly previousCheckpoint: string | undefined;
    readonly transcriptBudgetTokens?: number;
  },
  entries: { content: string; role: ModelMessage["role"] }[],
): void {
  const budget = input.transcriptBudgetTokens;
  if (budget === undefined) {
    return;
  }

  const fullPrompt = formatCompactionPrompt({
    previousCheckpoint: input.previousCheckpoint?.trim() ?? "(none)",
    transcript: formatCompactionTranscript(entries),
  });
  let excessTokens = estimateTokens(fullPrompt) - budget;

  for (let index = 0; index < entries.length && excessTokens > 0; index += 1) {
    const entry = entries[index];
    const message = input.messages[index];
    if (entry === undefined || message === undefined) {
      continue;
    }

    const degraded = renderCompactionMessageContent(message, DEGRADED_TEXT_LIMIT);
    if (degraded.length >= entry.content.length) {
      continue;
    }

    excessTokens -= (entry.content.length - degraded.length) / 4;
    entries[index] = { content: degraded, role: entry.role };
  }
}

function formatCompactionPrompt(input: {
  readonly previousCheckpoint: string;
  readonly transcript: string;
}): string {
  return `<previous-checkpoint>
${input.previousCheckpoint}
</previous-checkpoint>

<conversation>
Conversation transcript:
${input.transcript}
</conversation>

${COMPACTION_CHECKPOINT_PROMPT}`;
}

function formatCompactionTranscript(messages: readonly CompactionTranscriptEntry[]): string {
  const sections = messages
    .filter((message) => message.content.trim().length > 0)
    .map((message) => `### ${message.role}\n${message.content.trim()}`);

  return sections.length === 0 ? "(empty)" : sections.join("\n\n");
}

function renderCompactionMessageContent(
  message: ModelMessage,
  conversationTextLimit?: number,
): string {
  if (typeof message.content === "string") {
    return renderConversationText(message.content, conversationTextLimit);
  }

  return message.content
    .map((part) => renderCompactionContentPart(part, conversationTextLimit))
    .filter((summary) => summary.length > 0)
    .join("\n")
    .trim();
}

type ModelMessageContentPart = Exclude<ModelMessage["content"], string>[number];

function renderCompactionContentPart(
  part: ModelMessageContentPart,
  conversationTextLimit?: number,
): string {
  switch (part.type) {
    case "text":
      return renderConversationText(part.text, conversationTextLimit);
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

/**
 * One-line trail rendering of an evicted tool call merged with its paired
 * result, e.g. `Called grep with object(pattern=…) → returned object(…)`.
 * Used when compaction evicts tool activity from older history without
 * summarizing: the trail keeps durable evidence of what already ran.
 */
export function renderEvictedToolActivity(
  call: { toolName: string; input?: unknown },
  result?: { output?: unknown; isError?: boolean },
): string {
  const called = summarizeToolCallPart(call);
  if (result === undefined) {
    return `${called} → no recorded result`;
  }

  const status = result.isError ? "errored" : "returned";
  const output = result.output !== undefined ? summarizeCompactValue(result.output) : "";
  return output ? `${called} → ${status} ${output}` : `${called} → ${status}`;
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
  if (typeof value === "string") return capText(value, COMPACTION_TOOL_TEXT_LIMIT);
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

function renderConversationText(value: string, limit?: number): string {
  return limit === undefined ? value.trim() : capText(value, limit);
}

function capText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit).trimEnd()}…`;
}
