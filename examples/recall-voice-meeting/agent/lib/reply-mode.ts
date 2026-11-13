/**
 * Where one reply goes. The agent starts each message with a tag, such as
 * `[chat] Here's the link: ...`, and an untagged message is spoken.
 */
export type ReplyMode = "voice" | "chat" | "both";

const TAG = /^\s*\[(voice|chat|both)\]\s*/iu;
/** Long enough to hold any tag, so a message without one isn't held up. */
const MAX_TAG_CHARS = 10;

/**
 * Reads the tag at the start of `text`. Returns `undefined` while `text`
 * could still be the start of a tag, such as `[ch` mid-stream.
 */
export function readReplyMode(
  text: string,
): { readonly mode: ReplyMode; readonly text: string } | undefined {
  const match = TAG.exec(text);
  if (match !== null) {
    return { mode: match[1]!.toLowerCase() as ReplyMode, text: text.slice(match[0].length) };
  }
  const start = text.trimStart();
  if (start.startsWith("[") && start.length < MAX_TAG_CHARS && !start.includes("]")) {
    return undefined;
  }
  return { mode: "voice", text };
}

/** `readReplyMode` for a finished message, which can't be the start of a tag anymore. */
export function replyModeOf(text: string): { readonly mode: ReplyMode; readonly text: string } {
  return readReplyMode(text) ?? { mode: "voice", text };
}
