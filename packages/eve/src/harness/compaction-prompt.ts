import type { ModelMessage } from "ai";

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

const COMPACTION_TEXT_LIMIT = 280;
const COMPACTION_COLLECTION_LIMIT = 3;

interface CompactionTranscriptMessage {
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

/** Builds the compaction model input from framework-owned checkpoint state and older messages. */
export function createCompactionPrompt(input: {
  readonly messages: readonly ModelMessage[];
  readonly previousCheckpoint: string | undefined;
}): CompactionPrompt {
  const transcript = input.messages.map((message) => ({
    content: summarizeCompactionMessageContent(message),
    role: message.role,
  }));

  return {
    prompt: formatCompactionPrompt({
      previousCheckpoint: input.previousCheckpoint?.trim() ?? "(none)",
      transcript: formatCompactionTranscript(transcript),
    }),
    system: COMPACTION_SYSTEM_PROMPT,
  };
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

function formatCompactionTranscript(messages: readonly CompactionTranscriptMessage[]): string {
  const sections = messages
    .filter((message) => message.content.trim().length > 0)
    .map((message) => `### ${message.role}\n${message.content.trim()}`);

  return sections.length === 0 ? "(empty)" : sections.join("\n\n");
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

type ModelMessageContentPart = Exclude<ModelMessage["content"], string>[number];

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
