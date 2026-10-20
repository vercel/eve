import type { UserContent } from "ai";

import type { Attachment, Message } from "#compiled/chat/index.js";
import { readLimitedBytes } from "#internal/attachments/limited-read.js";
import { messageToUserContent } from "#public/channels/chat-sdk/index.js";
import {
  fetchMessageBestEffort,
  type MessageLookup,
} from "#public/channels/chat-sdk/fetch-message.js";
import type { QuotedMessage } from "#public/channels/chat-sdk/reply-context.js";
import { DEFAULT_UPLOAD_POLICY } from "#public/channels/upload-policy.js";

/** Returns model-visible Linq content, or `undefined` for blank messages. */
export function linqInboundContent(message: Message): string | UserContent | undefined {
  const content = messageToUserContent(message);
  if (typeof content === "string") return content.trim().length > 0 ? content : undefined;
  return content.length > 0 ? content : undefined;
}

/**
 * Returns the message a Linq reply quotes. The webhook names only the target's
 * id, so this fetches its text; a failed or slow lookup still reports the reply.
 */
export async function linqQuotedMessage(
  adapter: MessageLookup,
  message: Message,
): Promise<QuotedMessage | undefined> {
  const replyTo = (message.raw as { readonly reply_to?: { readonly message_id?: unknown } | null })
    ?.reply_to;
  const id = replyTo?.message_id;
  if (typeof id !== "string" || id.length === 0) return undefined;
  // A failed lookup still reaches the model as a reply, just without the quoted text.
  const target = await fetchMessageBestEffort(adapter, message.threadId, id);
  if (target === null) return { id };
  return { fromAgent: target.author.isMe, id, text: target.text };
}

/**
 * Rebuilds a Linq attachment's download after the message crosses the queue.
 * The Linq adapter downloads from its CDN URL without credentials but has no
 * `rehydrateAttachment`, so this does the same, stopping at the upload limit.
 */
export function rehydrateLinqAttachment(attachment: Attachment): Attachment {
  const { url } = attachment;
  if (!url) return attachment;
  return {
    ...attachment,
    async fetchData() {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Linq CDN returned HTTP ${response.status}.`);
      return await readLimitedBytes(response, DEFAULT_UPLOAD_POLICY.maxBytes, "linq");
    },
  };
}
