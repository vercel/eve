import type { ModelMessage } from "ai";

import { estimateTokens } from "#harness/token-estimate.js";

export const COMPACTION_CHECKPOINT_MARKER = "Summary of our conversation so far:";

/** Synthetic resumption prompt used when no real user message can be replayed. */
export const COMPACTION_RESUMPTION_MESSAGE = "Continue.";

/**
 * Label line of the framework-injected todo preservation message. Owned here
 * so compaction can recognize the message as synthetic when picking a user
 * message to replay after compaction.
 */
export const TODO_COMPACTION_PRESERVATION_LABEL =
  "[Your task list was preserved across context compaction]";

const COMPACTION_SYSTEM_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:

- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done, with clear next steps
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work. Write in the same language as the conversation. Do not continue the conversation, answer its questions, or invent facts. Only output the handoff summary.`;

const COMPACTION_CHECKPOINT_PROMPT = `Update the previous checkpoint with the newer information in the conversation. If there is no previous checkpoint, create one from the conversation.

Make completed work explicit so the next model does not repeat it. Keep completed work separate from current and remaining work, and do not describe completed work as pending unless later messages show it must be redone. Preserve exact file paths, function names, commands, error messages, identifiers, and measured values when they are needed to continue.

Large tool outputs are the main thing to compress: reduce each to the findings the next model needs — what was searched or read, what it established, and the exact identifiers involved — rather than reproducing the output. The next model cannot see the originals, so nothing it would need to act on may be lost.`;

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
      return renderTranscriptToolCall(part, conversationTextLimit);
    case "tool-result":
      return renderTranscriptToolResult(part, conversationTextLimit);
    default:
      return "";
  }
}

// Raw tool payloads reach the summarizer clipped, not pre-summarized: the
// checkpoint model decides what matters in a grep result or file read. The
// transcript limit keeps enough content to judge a payload without letting
// one result dominate the prompt; the compact limit applies where a one-line
// rendering is the point — budget-degraded transcript entries.
export const TRANSCRIPT_PAYLOAD_LIMIT = 2_000;
const COMPACT_PAYLOAD_LIMIT = 280;

function renderTranscriptToolCall(
  part: { toolName: string; input?: unknown },
  conversationTextLimit?: number,
): string {
  const limit =
    conversationTextLimit === undefined ? TRANSCRIPT_PAYLOAD_LIMIT : COMPACT_PAYLOAD_LIMIT;
  return renderToolCall(part, limit);
}

function renderTranscriptToolResult(
  part: { toolName: string; output?: unknown; isError?: boolean },
  conversationTextLimit?: number,
): string {
  const limit =
    conversationTextLimit === undefined ? TRANSCRIPT_PAYLOAD_LIMIT : COMPACT_PAYLOAD_LIMIT;
  const status = part.isError ? "errored" : "returned";
  const output = renderPayload(part.output, limit);
  return output ? `Tool ${part.toolName} ${status} ${output}` : `Tool ${part.toolName} ${status}`;
}

function renderToolCall(part: { toolName: string; input?: unknown }, limit: number): string {
  const input = renderPayload(part.input, limit);
  return input ? `Called ${part.toolName} with ${input}` : `Called ${part.toolName}`;
}

function renderPayload(value: unknown, limit: number): string {
  if (value === undefined) return "";
  return capText(JSON.stringify(value) ?? "", limit);
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
