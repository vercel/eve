import type { UserContent } from "ai";

import type { Message } from "#compiled/chat/index.js";
import { messageToUserContent } from "#public/channels/chat-sdk/index.js";

type UserContentParts = Exclude<UserContent, string>;

/**
 * Returns model-visible Photon content, or `undefined` for non-message events.
 *
 * Photon's webhook strips file bytes, and it sends some files, such as voice
 * notes, without the id eve downloads them by. Each of those reaches the agent
 * as a short note, so an attachment-only message still starts a turn.
 */
export function photonInboundContent(message: Message): string | UserContent | undefined {
  const content = messageToUserContent(message);
  const notes: UserContentParts = (message.attachments ?? [])
    .filter((attachment) => attachment.fetchData === undefined && !attachment.url)
    .map((attachment) => ({
      text: `Attachment ${attachment.name ?? "file"} was not retrieved: Photon did not provide a download for it.`,
      type: "text",
    }));
  if (typeof content === "string") {
    const text = content.trim().length > 0 ? content : undefined;
    if (notes.length === 0) return text;
    return text === undefined ? notes : [{ text, type: "text" }, ...notes];
  }
  const parts = [...content, ...notes];
  return parts.length > 0 ? parts : undefined;
}
