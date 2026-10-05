import type { UserContent } from "ai";

import type { Attachment, Message } from "#compiled/chat/index.js";
import { createLogger } from "#internal/logging.js";
import { DEFAULT_UPLOAD_POLICY } from "#public/channels/upload-policy.js";

type UserContentParts = Exclude<UserContent, string>;

const log = createLogger("chat-sdk.attachments");

/**
 * Converts a Chat SDK `Message` into the input shape `chatSdkChannel().send`
 * accepts.
 *
 * Resolves to `message.text` when the message has no attachments. Otherwise
 * resolves to an AI SDK `UserContent` array: the text (when non-empty)
 * followed by one part per attachment.
 *
 * An attachment the adapter can download (`fetchData`) is downloaded with the
 * adapter's credentials and passed as bytes, because a platform's file URL
 * usually needs those credentials and the model provider can't open it. A
 * failed download, or a file over 25 MB, becomes a short text note so the turn
 * still runs. An attachment with only a URL is passed as that URL. Attachments
 * with neither are skipped.
 */
export async function messageToUserContent(message: Message): Promise<string | UserContent> {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) {
    return message.text;
  }

  const parts: UserContentParts = [];
  if (message.text) {
    parts.push({ text: message.text, type: "text" });
  }
  for (const attachment of attachments) {
    const part = await attachmentToPart(attachment);
    if (part !== null) parts.push(part);
  }
  return parts.length > 0 ? parts : message.text;
}

async function attachmentToPart(attachment: Attachment): Promise<UserContentParts[number] | null> {
  const mediaType = attachment.mimeType ?? "application/octet-stream";
  if (attachment.fetchData === undefined) {
    if (!attachment.url) return null;
    return { data: new URL(attachment.url), filename: attachment.name, mediaType, type: "file" };
  }

  const name = attachment.name ?? "file";
  const { maxBytes } = DEFAULT_UPLOAD_POLICY;
  if (attachment.size !== undefined && attachment.size > maxBytes) {
    return {
      text: `Attachment ${name} was not retrieved: it is over the upload limit.`,
      type: "text",
    };
  }
  let bytes: Buffer;
  try {
    const data = await attachment.fetchData();
    bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  } catch (error) {
    log.warn("attachment download failed — degrading to text part", { error, name });
    return { text: `Attachment ${name} could not be retrieved.`, type: "text" };
  }
  if (bytes.byteLength > maxBytes) {
    return {
      text: `Attachment ${name} was not retrieved: it is over the upload limit.`,
      type: "text",
    };
  }
  return { data: bytes, filename: attachment.name, mediaType, type: "file" };
}
