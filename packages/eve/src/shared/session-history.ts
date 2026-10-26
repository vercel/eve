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

/**
 * Validates `history` at the send boundary and returns a normalized copy that
 * carries only contract fields. Returns `undefined` when `history` is omitted.
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
