import { isObject } from "#shared/guards.js";

/**
 * One prior message passed as `history` to `send()` or `create()`.
 *
 * Entries become real user and assistant turns in the session's model history
 * and are published in the `history.imported` stream event.
 */
export interface SessionHistoryMessage {
  /** Optional app-owned id, echoed in `history.imported` so clients can join annotations. */
  readonly id?: string;
  readonly role: "user" | "assistant";
  /** Plain text. Channels render speaker attribution into this text when needed. */
  readonly content: string;
}

/** Most messages one seeded history may contain. */
export const MAX_SESSION_HISTORY_MESSAGES = 500;

/** Most UTF-8 bytes of `content`, summed across one seeded history. */
export const MAX_SESSION_HISTORY_CONTENT_BYTES = 512 * 1024;

const MAX_SESSION_HISTORY_ID_LENGTH = 256;

/** Thrown when `history` passed to a send does not satisfy the seeding contract. */
export class InvalidSessionHistoryError extends Error {
  override readonly name = "InvalidSessionHistoryError";
}

const textEncoder = new TextEncoder();

/** UTF-8 size of one message's content, as counted against the history cap. */
export function sessionHistoryContentBytes(message: SessionHistoryMessage): number {
  return textEncoder.encode(message.content).byteLength;
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
  if (history.length > MAX_SESSION_HISTORY_MESSAGES) {
    throw new InvalidSessionHistoryError(
      `history has ${history.length} messages; the limit is ${MAX_SESSION_HISTORY_MESSAGES}.`,
    );
  }

  const ids = new Set<string>();
  let bytes = 0;
  const normalized = history.map((entry: unknown, index): SessionHistoryMessage => {
    const at = `history[${index}]`;
    if (!isObject(entry)) throw new InvalidSessionHistoryError(`${at} must be an object.`);
    const { content, id, role } = entry;
    if (role !== "user" && role !== "assistant") {
      throw new InvalidSessionHistoryError(`${at}.role must be "user" or "assistant".`);
    }
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new InvalidSessionHistoryError(`${at}.content must be a non-empty string.`);
    }
    const message: SessionHistoryMessage = { content, role };
    bytes += sessionHistoryContentBytes(message);
    if (id === undefined) return message;
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_SESSION_HISTORY_ID_LENGTH) {
      throw new InvalidSessionHistoryError(
        `${at}.id must be a non-empty string of at most ${MAX_SESSION_HISTORY_ID_LENGTH} characters.`,
      );
    }
    if (ids.has(id)) throw new InvalidSessionHistoryError(`${at}.id "${id}" is not unique.`);
    ids.add(id);
    return { ...message, id };
  });

  if (bytes > MAX_SESSION_HISTORY_CONTENT_BYTES) {
    throw new InvalidSessionHistoryError(
      `history content is ${bytes} bytes; the limit is ${MAX_SESSION_HISTORY_CONTENT_BYTES}.`,
    );
  }
  return normalized;
}
