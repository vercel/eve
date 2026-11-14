/**
 * Where one reply goes. The agent starts each message with a tag, such as
 * `[chat] Here's the link: ...`. An untagged message goes where the request
 * came from; see `untaggedMode`.
 */
export type ReplyMode = "voice" | "chat" | "both";

const TAG = /^\s*\[(voice|chat|both)\]\s*/iu;
/** Long enough to hold any tag, so a message without one isn't held up. */
const MAX_TAG_CHARS = 10;
/** How the channel shows a chat message to the model: `Alice (in chat):` on its own line. */
const CHAT_LINE = /^[^\n]* \(in chat\):\n/u;

/**
 * Reads the tag at the start of `text`; `mode` is `null` when it has none.
 * Returns `undefined` while `text` could still be the start of a tag, such as
 * `[ch` mid-stream.
 */
export function readReplyMode(
  text: string,
): { readonly mode: ReplyMode | null; readonly text: string } | undefined {
  const match = TAG.exec(text);
  if (match !== null) {
    return { mode: match[1]!.toLowerCase() as ReplyMode, text: text.slice(match[0].length) };
  }
  const start = text.trimStart();
  if (start.startsWith("[") && start.length < MAX_TAG_CHARS && !start.includes("]")) {
    return undefined;
  }
  return { mode: null, text };
}

/** `readReplyMode` for a finished message, which can't be the start of a tag anymore. */
export function replyModeOf(text: string): {
  readonly mode: ReplyMode | null;
  readonly text: string;
} {
  return readReplyMode(text) ?? { mode: null, text };
}

/**
 * Whether a line the model received is a chat message rather than speech.
 * An untagged message in a turn started only by chat stays out of the room,
 * since it's usually the model thinking aloud about how to answer.
 */
export function isChatLine(text: string): boolean {
  return CHAT_LINE.test(text);
}
