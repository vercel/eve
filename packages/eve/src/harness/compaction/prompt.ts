import type { ModelMessage, ToolResultPart } from "ai";

import { estimateTokens } from "#harness/token-estimate.js";
import { decodeSandboxRef, isSandboxRefUrl } from "#internal/attachments/sandbox-refs.js";

export const COMPACTION_CHECKPOINT_MARKER = "Summary of our conversation so far:";

export const COMPACTION_RESUMPTION_MESSAGE = "Continue.";

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

const DEGRADED_TEXT_LIMIT = 2_000;
const DEGRADE_SLACK_CHARS = 64;

interface CompactionTranscriptEntry {
  readonly content: string;
  readonly role: ModelMessage["role"];
}

interface CompactionPrompt {
  readonly prompt: string;
  readonly system: string;
}

export const COMPACTION_PROMPT_ENVELOPE = {
  prompt: formatCompactionPrompt({ previousCheckpoint: "", transcript: "" }),
  system: COMPACTION_SYSTEM_PROMPT,
} satisfies CompactionPrompt;

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

    const limit = Math.max(
      DEGRADED_TEXT_LIMIT,
      entry.content.length - Math.ceil(excessTokens * 4) - DEGRADE_SLACK_CHARS,
    );
    const degraded = renderCompactionMessageContent(message, limit);
    if (degraded.length >= entry.content.length) {
      continue;
    }

    excessTokens -= (Buffer.byteLength(entry.content) - Buffer.byteLength(degraded)) / 4;
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
      return renderAttachedFileStub(part.filename, part.mediaType);
    case "tool-call":
      return renderTranscriptToolCall(part, conversationTextLimit);
    case "tool-result":
      return renderTranscriptToolResult(part, conversationTextLimit);
    default:
      return "";
  }
}

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
  part: ToolResultPart & { readonly isError?: boolean },
  conversationTextLimit?: number,
): string {
  const limit =
    conversationTextLimit === undefined ? TRANSCRIPT_PAYLOAD_LIMIT : COMPACT_PAYLOAD_LIMIT;
  const outputType =
    part.output !== null && typeof part.output === "object" ? part.output.type : undefined;
  const isError =
    part.isError === true || outputType === "error-text" || outputType === "error-json";
  const status = isError ? "errored" : "returned";
  const output = renderToolResultOutput(part.output, limit);
  return output ? `Tool ${part.toolName} ${status} ${output}` : `Tool ${part.toolName} ${status}`;
}

function renderToolResultOutput(value: unknown, limit: number): string {
  const parts = contentToolOutputParts(value);
  if (parts === undefined) {
    return capPayload(serializeToolResultOutput(value), limit);
  }
  const rendered = parts
    .map((part) => renderContentToolOutputPart(part, limit))
    .filter((entry) => entry.length > 0)
    .join(" ");
  return capPayload(rendered, limit);
}

export function serializeToolResultOutput(output: unknown): string {
  if (output !== null && typeof output === "object") {
    const candidate = output as { readonly type?: unknown; readonly value?: unknown };
    if (
      (candidate.type === "text" || candidate.type === "error-text") &&
      typeof candidate.value === "string"
    ) {
      return candidate.value;
    }
  }
  return JSON.stringify(output) ?? "";
}

function contentToolOutputParts(value: unknown): readonly unknown[] | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as { readonly type?: unknown; readonly value?: unknown };
  return candidate.type === "content" && Array.isArray(candidate.value)
    ? candidate.value
    : undefined;
}

export function stubContentOutputFileParts(output: unknown): unknown {
  const parts = contentToolOutputParts(output);
  if (parts === undefined) return output;

  let changed = false;
  const value = parts.map((part) => {
    if (part === null || typeof part !== "object") return part;
    const candidate = part as {
      readonly type?: unknown;
      readonly mediaType?: unknown;
    };
    if (candidate.type !== "file" && candidate.type !== "media") return part;
    changed = true;
    return {
      text: renderAttachedFileStub(
        contentFileName(part),
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
  if (candidate.type === "file" || candidate.type === "media") {
    return renderAttachedFileStub(
      contentFileName(part),
      typeof candidate.mediaType === "string" ? candidate.mediaType : "unknown",
    );
  }
  return renderPayload(part, limit);
}

function contentFileName(part: object): string | undefined {
  const { data, filename } = part as { readonly data?: unknown; readonly filename?: unknown };
  const tagged = data as { readonly type?: unknown; readonly url?: unknown } | undefined;
  if (tagged?.type === "url" && isSandboxRefUrl(tagged.url)) {
    return decodeSandboxRef(tagged.url).path;
  }
  return typeof filename === "string" ? filename : undefined;
}

function renderToolCall(part: { toolName: string; input?: unknown }, limit: number): string {
  const input = renderPayload(part.input, limit);
  return input ? `Called ${part.toolName} with ${input}` : `Called ${part.toolName}`;
}

function renderPayload(value: unknown, limit: number): string {
  if (value === undefined) return "";
  return capPayload(JSON.stringify(value) ?? "", limit);
}

function renderAttachedFileStub(filename: string | undefined, mediaType: string): string {
  return `Attached file ${filename ?? "attachment"} (${mediaType})`;
}

function renderConversationText(value: string, limit?: number): string {
  return limit === undefined ? value.trim() : capText(value, limit);
}

export function sliceUtf16Safe(value: string, limit: number): string {
  if (limit <= 0) {
    return "";
  }
  if (value.length <= limit) {
    return value;
  }
  let end = limit;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return value.slice(0, end);
}

export function clipMiddleUtf16Safe(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  const kept = limit - elisionMarker(value.length).length;
  const head = sliceUtf16Safe(value, Math.ceil(kept * 0.6));
  let tailStart = value.length - (kept - head.length);
  const first = value.charCodeAt(tailStart);
  if (first >= 0xdc00 && first <= 0xdfff) {
    tailStart += 1;
  }
  const tail = value.slice(tailStart);
  return `${head}${elisionMarker(tailStart - head.length)}${tail}`;
}

function elisionMarker(omitted: number): string {
  return ` … [${omitted} chars omitted] … `;
}

function capPayload(value: string, limit: number): string {
  return clipMiddleUtf16Safe(value.replace(/\s+/g, " ").trim(), limit);
}

function capText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${sliceUtf16Safe(normalized, limit).trimEnd()}…`;
}
