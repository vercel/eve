import { isObject } from "#shared/guards.js";

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
}

/** Thrown when `history` passed to a send does not satisfy the seeding contract. */
export class InvalidSessionHistoryError extends Error {
  override readonly name = "InvalidSessionHistoryError";
}

const HISTORY_FIELDS: readonly string[] = ["id", "role", "text"];

/**
 * Validates `history` at the send boundary and returns a normalized copy.
 * Returns `undefined` when `history` is omitted. An entry with a field outside
 * the contract is rejected, not dropped, so no caller already sends a field a
 * later release starts to read.
 */
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
    rejectUnknownFields(entry, at);
    const { id, role, text } = entry;
    if (role !== "user" && role !== "assistant") {
      throw new InvalidSessionHistoryError(`${at}.role must be "user" or "assistant".`);
    }
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new InvalidSessionHistoryError(`${at}.text must be a non-empty string.`);
    }
    const message: SessionHistoryMessage = { role, text };
    if (id === undefined) return message;
    if (typeof id !== "string" || id.length === 0) {
      throw new InvalidSessionHistoryError(`${at}.id must be a non-empty string.`);
    }
    if (ids.has(id)) throw new InvalidSessionHistoryError(`${at}.id "${id}" is not unique.`);
    ids.add(id);
    return { ...message, id };
  });
}

function rejectUnknownFields(entry: Readonly<Record<string, unknown>>, at: string): void {
  // An absent value names nothing a later release could read differently.
  const unknown = Object.keys(entry).filter(
    (key) => !HISTORY_FIELDS.includes(key) && entry[key] !== undefined,
  );
  if (unknown.length === 0) return;
  const names = unknown
    .slice(0, 8)
    .sort()
    .map((key) => JSON.stringify(key.length > 128 ? `${key.slice(0, 128)}…` : key));
  const omitted = unknown.length > 8 ? " (and more)" : "";
  throw new InvalidSessionHistoryError(
    `${at} has unknown field${unknown.length === 1 ? "" : "s"} ${names.join(", ")}${omitted}. ` +
      `Accepted fields: ${HISTORY_FIELDS.join(", ")}.`,
  );
}
