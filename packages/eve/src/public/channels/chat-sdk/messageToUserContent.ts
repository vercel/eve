import type { UserContent } from "ai";

import type { Attachment, Message } from "#compiled/chat/index.js";
import { encodeChatSdkFileRef } from "#public/channels/chat-sdk/attachment-refs.js";
import { DEFAULT_UPLOAD_POLICY } from "#public/channels/upload-policy.js";

type UserContentParts = Exclude<UserContent, string>;

/**
 * Converts a Chat SDK `Message` into the input shape `chatSdkChannel().send`
 * accepts.
 *
 * Returns `message.text` when the message has no attachments. Otherwise
 * returns an AI SDK `UserContent` array: the text (when non-empty) followed by
 * one part per attachment.
 *
 * An attachment the adapter can download (`fetchData`) becomes a file part the
 * channel downloads later, in the step, with the adapter's credentials: a
 * platform's file URL usually needs them, so the model provider couldn't open
 * it. The channel rebuilds the download with the adapter's
 * `rehydrateAttachment`. A file over 25 MB, or one that fails to download,
 * reaches the agent as a short note. An attachment with only a URL is passed as
 * that URL. An attachment with neither also becomes a note, so a file the
 * platform gave no way to download is never dropped silently.
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
  // Chat SDK thread ids start with the name of the adapter that owns them.
  const adapter = message.threadId.split(":")[0]!;
  for (const attachment of attachments) {
    parts.push(attachmentToPart(adapter, attachment));
  }
  return parts;
}

function attachmentToPart(adapter: string, attachment: Attachment): UserContentParts[number] {
  const mediaType = attachment.mimeType ?? "application/octet-stream";
  if (attachment.fetchData === undefined) {
    if (!attachment.url) {
      return {
        text: `Attachment ${attachment.name ?? "file"} was not retrieved: the platform did not provide a download for it.`,
        type: "text",
      };
    }
    return { data: new URL(attachment.url), filename: attachment.name, mediaType, type: "file" };
  }
  if (attachment.size !== undefined && attachment.size > DEFAULT_UPLOAD_POLICY.maxBytes) {
    return {
      text: `Attachment ${attachment.name ?? "file"} was not retrieved: it is over the upload limit.`,
      type: "text",
    };
  }
  return {
    data: encodeChatSdkFileRef({ adapter, attachment }),
    filename: attachment.name,
    mediaType,
    type: "file",
  };
}
