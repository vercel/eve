import type { UserContent } from "ai";

import type { Message } from "#compiled/chat/index.js";

type UserContentParts = Exclude<UserContent, string>;

/**
 * Converts a Chat SDK `Message` into the input shape `chatSdkChannel().send`
 * accepts.
 *
 * Returns `message.text` when the message has no attachments. When attachments
 * are present, returns an AI SDK `UserContent` array: the text (when non-empty)
 * followed by one `file` part per attachment that exposes a URL. Attachments
 * without a URL are skipped, and a message whose only attachments lack URLs
 * falls back to `message.text`.
 */
export function messageToUserContent(message: Message): string | UserContent {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) {
    return message.text;
  }

  const parts: UserContentParts = [];
  if (message.text) {
    parts.push({ text: message.text, type: "text" });
  }
  for (const attachment of attachments) {
    if (!attachment.url) continue;
    parts.push({
      data: new URL(attachment.url),
      filename: attachment.name,
      mediaType: attachment.mimeType ?? "application/octet-stream",
      type: "file",
    });
  }
  return parts.length > 0 ? parts : message.text;
}
