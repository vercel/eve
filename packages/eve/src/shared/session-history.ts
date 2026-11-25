import type { ImportedMessage, ImportedPart } from "#protocol/session-events/families/delivery.js";
import { isObject } from "#shared/guards.js";
import type { JsonValue } from "#shared/json.js";

/**
 * One prior message passed as `history` to `send()` or `create()`.
 *
 * Entries become real user and assistant turns in the session's model history
 * and are recorded on the `delivery.consumed` of the message that brings them.
 * Give an entry either `text` or `parts`; `parts` lets an assistant message
 * carry the tool calls it made, with their results.
 */
export interface SessionHistoryMessage {
  /** Optional app-owned id, echoed in `delivery.consumed` history so clients can join annotations. */
  readonly id?: string;
  readonly role: "user" | "assistant";
  /** Plain text. Channels render speaker attribution into this text when needed. */
  readonly text?: string;
  /**
   * The message in order, in place of `text`. A user message takes text parts; an assistant
   * message also takes completed tool calls. Tool calls enter the model's history as data: eve
   * never runs them again or converts their output.
   */
  readonly parts?: readonly SessionHistoryPart[];
}

/** One part of a {@link SessionHistoryMessage}: text, or a tool call that finished. */
export type SessionHistoryPart =
  | { readonly type: "text"; readonly text: string }
  | SessionHistoryToolPart;

/**
 * A tool call an assistant message made, with what it returned in `output`, or why it failed in
 * `error`; give exactly one. `name` is the tool the model called; it doesn't have to be one the
 * agent still has.
 */
export interface SessionHistoryToolPart {
  readonly type: "tool";
  readonly name: string;
  /** Unique within the history. eve assigns one when omitted. */
  readonly callId?: string;
  readonly input?: JsonValue;
  readonly output?: JsonValue;
  readonly error?: string;
}

/** Thrown when `history` passed to a send does not satisfy the seeding contract. */
export class InvalidSessionHistoryError extends Error {
  override readonly name = "InvalidSessionHistoryError";
}

type ToolImportedPart = Extract<ImportedPart, { readonly type: "tool" }>;

const HISTORY_FIELDS: readonly string[] = ["id", "role", "text", "parts"];
const TEXT_PART_FIELDS: readonly string[] = ["type", "text"];
const TOOL_PART_FIELDS: readonly string[] = ["type", "name", "callId", "input", "output", "error"];

export function validateSessionHistory(history: unknown): readonly ImportedMessage[] | undefined {
  if (history === undefined) return undefined;
  if (!Array.isArray(history)) {
    throw new InvalidSessionHistoryError("history must be an array of messages.");
  }

  const ids = new Set<string>();
  const callIds = new Set<string>();
  return history.map((entry: unknown, index): ImportedMessage => {
    const at = `history[${index}]`;
    if (!isObject(entry)) throw new InvalidSessionHistoryError(`${at} must be an object.`);
    rejectUnknownFields(entry, at, HISTORY_FIELDS);
    const { id, role, text, parts } = entry;
    if (role !== "user" && role !== "assistant") {
      throw new InvalidSessionHistoryError(`${at}.role must be "user" or "assistant".`);
    }
    let message: ImportedMessage;
    if (parts !== undefined) {
      if (text !== undefined) {
        throw new InvalidSessionHistoryError(`${at} takes either text or parts, not both.`);
      }
      const validated = validateParts(parts, `${at}.parts`, role, callIds);
      message = { parts: validated, role, text: textOf(validated) };
    } else {
      if (typeof text !== "string" || text.trim().length === 0) {
        throw new InvalidSessionHistoryError(`${at}.text must be a non-empty string.`);
      }
      message = { role, text };
    }
    if (id === undefined) return message;
    if (typeof id !== "string" || id.length === 0) {
      throw new InvalidSessionHistoryError(`${at}.id must be a non-empty string.`);
    }
    if (ids.has(id)) throw new InvalidSessionHistoryError(`${at}.id "${id}" is not unique.`);
    ids.add(id);
    return { ...message, id };
  });
}

function validateParts(
  parts: unknown,
  at: string,
  role: "user" | "assistant",
  callIds: Set<string>,
): ImportedPart[] {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new InvalidSessionHistoryError(`${at} must be a non-empty array of parts.`);
  }
  return parts.map((part: unknown, index): ImportedPart => {
    const partAt = `${at}[${index}]`;
    if (!isObject(part)) throw new InvalidSessionHistoryError(`${partAt} must be an object.`);
    if (part.type === "text") {
      rejectUnknownFields(part, partAt, TEXT_PART_FIELDS);
      if (typeof part.text !== "string" || part.text.trim().length === 0) {
        throw new InvalidSessionHistoryError(`${partAt}.text must be a non-empty string.`);
      }
      return { text: part.text, type: "text" };
    }
    if (part.type !== "tool") {
      throw new InvalidSessionHistoryError(`${partAt}.type must be "text" or "tool".`);
    }
    if (role === "user") {
      throw new InvalidSessionHistoryError(`${partAt}: a user message takes only text parts.`);
    }
    rejectUnknownFields(part, partAt, TOOL_PART_FIELDS);
    return validateToolPart(part, partAt, callIds);
  });
}

function validateToolPart(
  part: Readonly<Record<string, unknown>>,
  at: string,
  callIds: Set<string>,
): ImportedPart {
  const { callId, error, input, name, output } = part;
  if (typeof name !== "string" || name.length === 0) {
    throw new InvalidSessionHistoryError(`${at}.name must be a non-empty string.`);
  }
  if ((output === undefined) === (error === undefined)) {
    throw new InvalidSessionHistoryError(
      `${at} must have exactly one of output, for a call that returned, or error, for one that failed.`,
    );
  }
  if (error !== undefined && typeof error !== "string") {
    throw new InvalidSessionHistoryError(`${at}.error must be a string.`);
  }
  for (const [field, value] of [
    ["input", input],
    ["output", output],
  ] as const) {
    if (value !== undefined && !isJson(value)) {
      throw new InvalidSessionHistoryError(`${at}.${field} must be JSON.`);
    }
  }
  if (callId !== undefined && (typeof callId !== "string" || callId.length === 0)) {
    throw new InvalidSessionHistoryError(`${at}.callId must be a non-empty string.`);
  }
  const id = typeof callId === "string" ? callId : `history_${crypto.randomUUID()}`;
  if (callIds.has(id)) {
    throw new InvalidSessionHistoryError(`${at}.callId "${id}" is not unique.`);
  }
  callIds.add(id);
  const validated: { -readonly [Key in keyof ToolImportedPart]: ToolImportedPart[Key] } = {
    callId: id,
    name,
    type: "tool",
  };
  if (input !== undefined) validated.input = input as JsonValue;
  if (typeof error === "string") validated.error = error;
  else validated.output = output as JsonValue;
  return validated;
}

function textOf(parts: readonly ImportedPart[]): string {
  return parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

const MAX_JSON_DEPTH = 64;

function isJson(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
  if (typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((item) => isJson(item, depth + 1));
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
