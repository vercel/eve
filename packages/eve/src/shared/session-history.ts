import { describeFilePart } from "#internal/attachments/file-part.js";
import { hasInternalRefScheme } from "#internal/attachments/url-refs.js";
import type { ImportedMessage, ImportedPart } from "#protocol/session-events/families/delivery.js";
import { isObject } from "#shared/guards.js";
import {
  checkJsonBounds,
  parseJsonObject,
  parseJsonValue,
  type JsonObject,
  type JsonValue,
} from "#shared/json.js";
import type { MessageFilePart } from "#shared/message-content.js";

/** A text block inside a structured {@link SessionHistoryMessage}. */
export interface SessionHistoryTextPart {
  readonly type: "text";
  /** Non-empty plain text. */
  readonly text: string;
}

/**
 * A file attachment inside a user {@link SessionHistoryMessage}.
 *
 * Uses the same shape as {@link MessageFilePart}: `data` is the file inline as bytes, base64, or a
 * `data:` URL, or a URL resolved through the channel's `fetchFile` hook or public HTTPS download.
 */
export type SessionHistoryFilePart<
  TData extends Uint8Array | ArrayBuffer | string | URL = Uint8Array | ArrayBuffer | string | URL,
> = MessageFilePart<TData>;

/**
 * One completed tool call inside an assistant {@link SessionHistoryMessage}.
 *
 * Carries its own result — either `output` or `error` — so an incomplete or pending call cannot
 * be written. eve does not execute the tool, run hooks or `toModelOutput`, or emit `call.*` facts.
 */
export type SessionHistoryToolPart = {
  readonly type: "tool";
  /** Tool name the model called (1 to 64 ASCII letters, digits, underscores, or dashes). */
  readonly name: string;
  /** JSON object arguments passed to the tool. Defaults to `{}`. */
  readonly input?: JsonObject;
} & (
  | {
      /** JSON value the model reads as the tool result. */
      readonly output: JsonValue;
      readonly error?: never;
    }
  | {
      readonly output?: never;
      /** Non-empty error message the model reads for a failed call. */
      readonly error: string;
    }
);

/** One content part accepted inside a user {@link SessionHistoryMessage}. */
export type SessionHistoryUserPart = SessionHistoryTextPart | SessionHistoryFilePart;

/** One content part accepted inside an assistant {@link SessionHistoryMessage}. */
export type SessionHistoryAssistantPart = SessionHistoryTextPart | SessionHistoryToolPart;

/**
 * One prior user message passed as `history` to `send()`, `create()`, or `t.session()`.
 * Supply either `text` or non-empty `parts` (ordered text and file attachments), never both.
 */
export type SessionHistoryUserMessage = {
  /** Optional app-owned id, echoed in `delivery.consumed` history so clients can join annotations. */
  readonly id?: string;
  readonly role: "user";
} & (
  | {
      /** Plain text. Channels render speaker attribution into this text when needed. */
      readonly text: string;
      readonly parts?: never;
    }
  | {
      readonly text?: never;
      /** Ordered text and file attachment parts for the user message. */
      readonly parts: readonly SessionHistoryUserPart[];
    }
);

/**
 * One prior assistant message passed as `history` to `send()`, `create()`, or `t.session()`.
 * Supply either `text` or non-empty `parts` (ordered text and completed tool exchanges), never both.
 */
export type SessionHistoryAssistantMessage = {
  /** Optional app-owned id, echoed in `delivery.consumed` history so clients can join annotations. */
  readonly id?: string;
  readonly role: "assistant";
} & (
  | {
      /** Plain text reply. */
      readonly text: string;
      readonly parts?: never;
    }
  | {
      readonly text?: never;
      /**
       * Ordered text and completed tool exchanges produced during the assistant turn.
       * Consecutive `tool` parts group into one parallel step; text before a `tool` part joins that
       * step as narration, and text after a `tool` part follows its result.
       */
      readonly parts: readonly SessionHistoryAssistantPart[];
    }
);

/**
 * One prior message passed as `history` to `send()`, `create()`, or `t.session()`.
 *
 * Entries become real user and assistant turns in the session's model history
 * and are recorded on the `delivery.consumed` of the message that brings them.
 */
export type SessionHistoryMessage = SessionHistoryUserMessage | SessionHistoryAssistantMessage;

/** Thrown when `history` passed to a send or create does not satisfy the seeding contract. */
export class InvalidSessionHistoryError extends Error {
  override readonly name = "InvalidSessionHistoryError";
}

const HISTORY_FIELDS: readonly string[] = ["id", "role", "text", "parts"];
const TEXT_PART_FIELDS: readonly string[] = ["type", "text"];
const FILE_PART_FIELDS: readonly string[] = ["type", "mediaType", "filename", "data"];
const TOOL_PART_FIELDS: readonly string[] = ["type", "name", "input", "output", "error"];
const HISTORY_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/u;

export function validateSessionHistory(
  history: unknown,
): readonly SessionHistoryMessage[] | undefined {
  if (history === undefined) return undefined;
  if (!Array.isArray(history)) {
    throw new InvalidSessionHistoryError("history must be an array of messages.");
  }

  const ids = new Set<string>();
  return history.map((entry: unknown, index): SessionHistoryMessage => {
    const at = `history[${index}]`;
    if (!isObject(entry)) throw new InvalidSessionHistoryError(`${at} must be an object.`);
    rejectUnknownFields(entry, at, HISTORY_FIELDS);

    const { id, parts, role, text } = entry;
    if (role !== "user" && role !== "assistant") {
      throw new InvalidSessionHistoryError(`${at}.role must be "user" or "assistant".`);
    }

    const validatedId = validateId(id, ids, at);
    if ((text === undefined) === (parts === undefined)) {
      throw new InvalidSessionHistoryError(`${at} must have exactly one of text or parts.`);
    }

    const base = validatedId === undefined ? {} : { id: validatedId };
    if (text !== undefined) {
      if (typeof text !== "string" || text.trim().length === 0) {
        throw new InvalidSessionHistoryError(`${at}.text must be a non-empty string.`);
      }
      return { ...base, role, text };
    }

    return role === "user"
      ? { ...base, parts: validateParts(parts, "user", `${at}.parts`), role }
      : { ...base, parts: validateParts(parts, "assistant", `${at}.parts`), role };
  });
}

export function toImportedHistoryMessages(
  history: readonly SessionHistoryMessage[],
): readonly ImportedMessage[] {
  return history.map((message): ImportedMessage => {
    const base =
      message.id === undefined ? { role: message.role } : { id: message.id, role: message.role };
    if (message.text !== undefined) return { ...base, text: message.text };
    const text = message.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    const parts: readonly ImportedPart[] = message.parts.map((part): ImportedPart =>
      part.type === "file"
        ? { type: "file", ...describeFilePart(part.data, part.mediaType, part.filename) }
        : part,
    );
    return { ...base, parts, text };
  });
}

function validateId(id: unknown, ids: Set<string>, at: string): string | undefined {
  if (id === undefined) return undefined;
  if (typeof id !== "string" || id.length === 0) {
    throw new InvalidSessionHistoryError(`${at}.id must be a non-empty string.`);
  }
  if (ids.has(id)) throw new InvalidSessionHistoryError(`${at}.id "${id}" is not unique.`);
  ids.add(id);
  return id;
}

function validateParts(parts: unknown, role: "user", at: string): readonly SessionHistoryUserPart[];
function validateParts(
  parts: unknown,
  role: "assistant",
  at: string,
): readonly SessionHistoryAssistantPart[];
function validateParts(
  parts: unknown,
  role: "user" | "assistant",
  at: string,
): readonly (SessionHistoryUserPart | SessionHistoryAssistantPart)[] {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new InvalidSessionHistoryError(`${at} must be a non-empty array.`);
  }
  return parts.map((part: unknown, index): SessionHistoryUserPart | SessionHistoryAssistantPart => {
    const partAt = `${at}[${index}]`;
    if (!isObject(part)) throw new InvalidSessionHistoryError(`${partAt} must be an object.`);
    if (part.type === "text") return validateTextPart(part, partAt);
    if (part.type === "file") {
      if (role === "assistant") {
        throw new InvalidSessionHistoryError(
          `${partAt} with type "file" is only accepted on a user message.`,
        );
      }
      return validateFilePart(part, partAt);
    }
    if (part.type === "tool") {
      if (role === "user") {
        throw new InvalidSessionHistoryError(
          `${partAt} with type "tool" is only accepted on an assistant message.`,
        );
      }
      return validateToolPart(part, partAt);
    }
    throw new InvalidSessionHistoryError(
      role === "user"
        ? `${partAt}.type must be "text" or "file".`
        : `${partAt}.type must be "text" or "tool".`,
    );
  });
}

function validateTextPart(
  part: Readonly<Record<string, unknown>>,
  at: string,
): SessionHistoryTextPart {
  rejectUnknownFields(part, at, TEXT_PART_FIELDS);
  if (typeof part.text !== "string" || part.text.trim().length === 0) {
    throw new InvalidSessionHistoryError(`${at}.text must be a non-empty string.`);
  }
  return { text: part.text, type: "text" };
}

function validateFilePart(
  part: Readonly<Record<string, unknown>>,
  at: string,
): SessionHistoryFilePart {
  rejectUnknownFields(part, at, FILE_PART_FIELDS);
  const { data, filename, mediaType } = part;
  if (typeof mediaType !== "string" || mediaType.trim().length === 0) {
    throw new InvalidSessionHistoryError(`${at}.mediaType must be a non-empty string.`);
  }
  if (filename !== undefined && (typeof filename !== "string" || filename.trim().length === 0)) {
    throw new InvalidSessionHistoryError(`${at}.filename must be a non-empty string.`);
  }
  const validatedData = validateFileData(data, `${at}.data`);
  return filename === undefined
    ? { data: validatedData, mediaType, type: "file" }
    : { data: validatedData, filename, mediaType, type: "file" };
}

function validateFileData(data: unknown, at: string): SessionHistoryFilePart["data"] {
  if (typeof data === "string") {
    if (data.length === 0) {
      throw new InvalidSessionHistoryError(`${at} must be a non-empty string.`);
    }
    if (hasInternalRefScheme(data)) {
      throw new InvalidSessionHistoryError(`${at} must not use a framework-internal ref scheme.`);
    }
    return data;
  }
  if (data instanceof URL) {
    if (hasInternalRefScheme(data.href)) {
      throw new InvalidSessionHistoryError(`${at} must not use a framework-internal ref scheme.`);
    }
    return data;
  }
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
    if (data.byteLength === 0) {
      throw new InvalidSessionHistoryError(`${at} must be non-empty.`);
    }
    return data;
  }
  throw new InvalidSessionHistoryError(
    `${at} must be a non-empty string, URL, Uint8Array, or ArrayBuffer.`,
  );
}

function validateToolPart(
  part: Readonly<Record<string, unknown>>,
  at: string,
): SessionHistoryToolPart {
  rejectUnknownFields(part, at, TOOL_PART_FIELDS);
  const { error, input, name, output } = part;
  if (typeof name !== "string" || !HISTORY_TOOL_NAME_PATTERN.test(name)) {
    throw new InvalidSessionHistoryError(
      `${at}.name must be 1 to 64 ASCII letters, digits, underscores, or dashes.`,
    );
  }
  if ((output === undefined) === (error === undefined)) {
    throw new InvalidSessionHistoryError(`${at} must have exactly one of output or error.`);
  }
  const normalizedInput =
    input === undefined ? undefined : parseHistoryJson(input, "object", `${at}.input`);
  const base =
    normalizedInput === undefined
      ? { name, type: "tool" as const }
      : { input: normalizedInput, name, type: "tool" as const };
  if (error === undefined) {
    return { ...base, output: parseHistoryJson(output, "value", `${at}.output`) };
  }
  if (typeof error !== "string" || error.trim().length === 0) {
    throw new InvalidSessionHistoryError(`${at}.error must be a non-empty string.`);
  }
  return { ...base, error };
}

function parseHistoryJson(value: unknown, kind: "object", at: string): JsonObject;
function parseHistoryJson(value: unknown, kind: "value", at: string): JsonValue;
function parseHistoryJson(value: unknown, kind: "object" | "value", at: string): JsonValue {
  let normalized: JsonValue;
  try {
    normalized = kind === "object" ? parseJsonObject(value) : parseJsonValue(value);
  } catch {
    throw new InvalidSessionHistoryError(`${at} must be a JSON ${kind}.`);
  }
  if (checkJsonBounds(normalized) === "prototype") {
    throw new InvalidSessionHistoryError(`${at} cannot contain prototype keys.`);
  }
  return normalized;
}

function rejectUnknownFields(
  entry: Readonly<Record<string, unknown>>,
  at: string,
  fields: readonly string[],
): void {
  const unknown = Object.keys(entry).filter(
    (key) => !fields.includes(key) && entry[key] !== undefined,
  );
  if (unknown.length === 0) return;
  const names = unknown
    .slice(0, 8)
    .sort()
    .map((key) => JSON.stringify(key.length > 128 ? `${key.slice(0, 128)}…` : key));
  const omitted = unknown.length > 8 ? " (and more)" : "";
  throw new InvalidSessionHistoryError(
    `${at} has unknown field${unknown.length === 1 ? "" : "s"} ${names.join(", ")}${omitted}. ` +
      `Accepted fields: ${fields.join(", ")}.`,
  );
}
