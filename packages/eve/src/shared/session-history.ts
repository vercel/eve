import { isObject } from "#shared/guards.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";

/**
 * One completed tool call on an assistant message passed as `history`, with the result the
 * model reads for it: exactly one of `output` or `error`. eve does not run the tool or check
 * `name` against the agent's tools.
 */
export interface SessionHistoryToolCall {
  /** The name the model called the tool by. */
  readonly name: string;
  /** The call's JSON input. Defaults to `{}`. */
  readonly input?: JsonValue;
  /** The JSON value the model reads as the tool's result. */
  readonly output?: JsonValue;
  /** The message the model reads as a failed call's error result. */
  readonly error?: string;
}

/**
 * One prior message passed as `history` to `send()` or `create()`.
 *
 * Entries become real user and assistant turns in the session's model history
 * and are recorded on the `delivery.consumed` of the message that brings them.
 */
export interface SessionHistoryMessage {
  /** Optional app-owned id, echoed in `delivery.consumed` history so clients can join annotations. */
  readonly id?: string;
  readonly role: "user" | "assistant";
  /** Plain text. Channels render speaker attribution into this text when needed. */
  readonly text: string;
  /**
   * Tool calls an assistant message made before it replied with `text`. The model reads them as
   * one step of calls and their results, followed by the reply.
   */
  readonly toolCalls?: readonly SessionHistoryToolCall[];
}

/** Thrown when `history` passed to a send does not satisfy the seeding contract. */
export class InvalidSessionHistoryError extends Error {
  override readonly name = "InvalidSessionHistoryError";
}

const HISTORY_FIELDS: readonly string[] = ["id", "role", "text", "toolCalls"];
const TOOL_CALL_FIELDS: readonly string[] = ["name", "input", "output", "error"];

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
    const { id, role, text } = entry;
    if (role !== "user" && role !== "assistant") {
      throw new InvalidSessionHistoryError(`${at}.role must be "user" or "assistant".`);
    }
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new InvalidSessionHistoryError(`${at}.text must be a non-empty string.`);
    }
    const toolCalls = validateToolCalls(entry.toolCalls, role, `${at}.toolCalls`);
    const message: SessionHistoryMessage =
      toolCalls.length === 0 ? { role, text } : { role, text, toolCalls };
    if (id === undefined) return message;
    if (typeof id !== "string" || id.length === 0) {
      throw new InvalidSessionHistoryError(`${at}.id must be a non-empty string.`);
    }
    if (ids.has(id)) throw new InvalidSessionHistoryError(`${at}.id "${id}" is not unique.`);
    ids.add(id);
    return { ...message, id };
  });
}

function validateToolCalls(
  toolCalls: unknown,
  role: SessionHistoryMessage["role"],
  at: string,
): readonly SessionHistoryToolCall[] {
  if (toolCalls === undefined) return [];
  if (role !== "assistant") {
    throw new InvalidSessionHistoryError(`${at} is only accepted on an assistant message.`);
  }
  if (!Array.isArray(toolCalls)) {
    throw new InvalidSessionHistoryError(`${at} must be an array of tool calls.`);
  }
  return toolCalls.map((call: unknown, index): SessionHistoryToolCall => {
    const callAt = `${at}[${index}]`;
    if (!isObject(call)) throw new InvalidSessionHistoryError(`${callAt} must be an object.`);
    rejectUnknownFields(call, callAt, TOOL_CALL_FIELDS);
    const { name, error } = call;
    if (typeof name !== "string" || name.length === 0) {
      throw new InvalidSessionHistoryError(`${callAt}.name must be a non-empty string.`);
    }
    if ((call.output === undefined) === (error === undefined)) {
      throw new InvalidSessionHistoryError(`${callAt} must have exactly one of output or error.`);
    }
    const input =
      call.input === undefined ? {} : { input: jsonValueAt(call.input, `${callAt}.input`) };
    if (error === undefined) {
      return { name, ...input, output: jsonValueAt(call.output, `${callAt}.output`) };
    }
    if (typeof error !== "string" || error.length === 0) {
      throw new InvalidSessionHistoryError(`${callAt}.error must be a non-empty string.`);
    }
    return { name, ...input, error };
  });
}

function jsonValueAt(value: unknown, at: string): JsonValue {
  try {
    return parseJsonValue(value);
  } catch {
    throw new InvalidSessionHistoryError(`${at} must be a JSON value.`);
  }
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
