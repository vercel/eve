import type { MessageContent } from "#shared/message-content.js";

import type { Attachment, Message } from "#compiled/chat/index.js";
import { requestPublicUrl } from "#execution/web-fetch/request.js";
import { ResponseTooLargeError } from "#execution/public-destination.js";
import { overLimit } from "#internal/attachments/limited-read.js";
import { messageContentOf } from "#public/channels/chat-sdk/index.js";
import {
  fetchMessageBestEffort,
  type MessageLookup,
} from "#public/channels/chat-sdk/fetch-message.js";
import type { QuotedMessage } from "#public/channels/chat-sdk/reply-context.js";
import { DEFAULT_UPLOAD_POLICY } from "#public/channels/upload-policy.js";

export function linqInboundContent(message: Message): MessageContent | undefined {
  const content = messageContentOf(message);
  if (typeof content === "string") return content.trim().length > 0 ? content : undefined;
  return content.length > 0 ? content : undefined;
}

export async function linqQuotedMessage(
  adapter: MessageLookup,
  message: Message,
): Promise<QuotedMessage | undefined> {
  const replyTo = (message.raw as { readonly reply_to?: { readonly message_id?: unknown } | null })
    ?.reply_to;
  const id = replyTo?.message_id;
  if (typeof id !== "string" || id.length === 0) return undefined;
  const target = await fetchMessageBestEffort(adapter, message.threadId, id);
  if (target === null) return { id };
  return { fromAgent: target.author.isMe, id, text: target.text };
}

export function rehydrateLinqAttachment(attachment: Attachment): Attachment {
  const { url } = attachment;
  if (!url) return attachment;
  return {
    ...attachment,
    async fetchData() {
      try {
        const response = await requestPublicUrl(url, {
          headers: {},
          maxResponseSize: DEFAULT_UPLOAD_POLICY.maxBytes,
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`Linq CDN returned HTTP ${response.status}.`);
        return Buffer.from(await response.arrayBuffer());
      } catch (error) {
        if (error instanceof ResponseTooLargeError) {
          throw overLimit(DEFAULT_UPLOAD_POLICY.maxBytes, "linq");
        }
        throw error;
      }
    },
  };
}
