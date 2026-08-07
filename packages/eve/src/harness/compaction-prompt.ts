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

const COMPACTION_CHECKPOINT_PROMPT = `Update the previous checkpoint with the newer information in the conversation. If there is no previous checkpoint, create one from the conversation.

Make completed work explicit so the next model does not repeat it. Keep completed work separate from current and remaining work, and do not describe completed work as pending unless later messages show it must be redone. Preserve exact file paths, function names, commands, error messages, identifiers, and measured values when they are needed to continue.

Large tool outputs are the main thing to compress: reduce each to the findings the next model needs — what was searched or read, what it established, and the exact identifiers involved — rather than reproducing the output. The next model cannot see the originals, so nothing it would need to act on may be lost.`;

const COMPACTION_SYSTEM_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:

- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done, with clear next steps
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work. Write in the same language as the conversation. Do not continue the conversation, answer its questions, or invent facts. Only output the handoff summary.

${COMPACTION_CHECKPOINT_PROMPT}`;

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
 * Conversational text is rendered verbatim. When `inputBudgetTokens` is
 * set and the combined system and user input exceeds it, conversational text is capped at
 * {@link DEGRADED_TEXT_LIMIT} starting from the oldest entries until the
 * input fits; the previous checkpoint is never truncated.
 */
export function createCompactionPrompt(input: {
  readonly messages: readonly ModelMessage[];
  readonly previousCheckpoint: string | undefined;
  readonly systemPrompt?: string;
  readonly inputBudgetTokens?: number;
}): CompactionPrompt {
  const entries = input.messages.map((message) => ({
    content: renderCompactionMessageContent(message),
    role: message.role,
  }));

  const system = input.systemPrompt ?? COMPACTION_SYSTEM_PROMPT;
  degradeOversizedTranscript({ ...input, systemPrompt: system }, entries);

  return {
    prompt: formatCompactionPrompt({
      previousCheckpoint: input.previousCheckpoint?.trim() ?? "(none)",
      transcript: formatCompactionTranscript(entries),
    }),
    system,
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
    readonly systemPrompt: string;
    readonly inputBudgetTokens?: number;
  },
  entries: { content: string; role: ModelMessage["role"] }[],
): void {
  const budget = input.inputBudgetTokens;
  if (budget === undefined) {
    return;
  }

  const fullPrompt = formatCompactionPrompt({
    previousCheckpoint: input.previousCheckpoint?.trim() ?? "(none)",
    transcript: formatCompactionTranscript(entries),
  });
  let excessTokens =
    estimateTokens([
      { content: input.systemPrompt, role: "system" },
      { content: fullPrompt, role: "user" },
    ]) - budget;

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
</conversation>`;
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
      return renderAttachedFileStub(part.filename, part.mediaType);
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
  const output = renderToolResultOutput(part.output, limit);
  return output ? `Tool ${part.toolName} ${status} ${output}` : `Tool ${part.toolName} ${status}`;
}

// A `content` tool output carries model-facing parts whose file payloads
// are base64: stringifying them would fill the payload budget with bytes
// the summarizer cannot read. File parts render as the same stub used for
// message file parts; text parts stay raw for the checkpoint model to judge.
function renderToolResultOutput(value: unknown, limit: number): string {
  const parts = contentToolOutputParts(value);
  if (parts === undefined) {
    return renderPayload(value, limit);
  }
  const rendered = parts
    .map((part) => renderContentToolOutputPart(part, limit))
    .filter((entry) => entry.length > 0)
    .join(" ");
  return capText(rendered, limit);
}

function contentToolOutputParts(value: unknown): readonly unknown[] | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as { readonly type?: unknown; readonly value?: unknown };
  return candidate.type === "content" && Array.isArray(candidate.value)
    ? candidate.value
    : undefined;
}

/**
 * Replaces the file parts of a `content` tool output with their text stubs,
 * leaving every other output shape untouched. History capping uses this so a
 * capped content output can never carry — or truncate into — a raw payload;
 * the stub matches the one the summarizer transcript renders.
 */
export function stubContentOutputFileParts(output: unknown): unknown {
  const parts = contentToolOutputParts(output);
  if (parts === undefined) return output;

  let changed = false;
  const value = parts.map((part) => {
    if (part === null || typeof part !== "object") return part;
    const candidate = part as {
      readonly type?: unknown;
      readonly filename?: unknown;
      readonly mediaType?: unknown;
    };
    if (candidate.type !== "file" && candidate.type !== "media") return part;
    changed = true;
    return {
      text: renderAttachedFileStub(
        typeof candidate.filename === "string" ? candidate.filename : undefined,
        typeof candidate.mediaType === "string" ? candidate.mediaType : "unknown",
      ),
      type: "text",
    };
  });
  return changed ? { type: "content", value } : output;
}

function renderContentToolOutputPart(part: unknown, limit: number): string {
  if (part === null || typeof part !== "object") return renderPayload(part, limit);
  const candidate = part as {
    readonly type?: unknown;
    readonly text?: unknown;
    readonly filename?: unknown;
    readonly mediaType?: unknown;
  };
  if (candidate.type === "text" && typeof candidate.text === "string") {
    return candidate.text;
  }
  // "media" is the AI SDK's deprecated spelling of a file part; both carry
  // an inline payload the summarizer cannot read.
  if (candidate.type === "file" || candidate.type === "media") {
    return renderAttachedFileStub(
      typeof candidate.filename === "string" ? candidate.filename : undefined,
      typeof candidate.mediaType === "string" ? candidate.mediaType : "unknown",
    );
  }
  return renderPayload(part, limit);
}

function renderToolCall(part: { toolName: string; input?: unknown }, limit: number): string {
  const input = renderPayload(part.input, limit);
  return input ? `Called ${part.toolName} with ${input}` : `Called ${part.toolName}`;
}

function renderPayload(value: unknown, limit: number): string {
  if (value === undefined) return "";
  return capText(JSON.stringify(value) ?? "", limit);
}

// One summarized-attachment surface for the checkpoint model, whether the
// file arrived on a message or inside a content tool output.
// `renderSandboxRefAsTextPart` in attachment-staging deliberately matches
// this shape.
function renderAttachedFileStub(filename: string | undefined, mediaType: string): string {
  return `Attached file ${filename ?? "attachment"} (${mediaType})`;
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
