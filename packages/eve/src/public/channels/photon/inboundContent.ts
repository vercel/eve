import type { UserContent } from "ai";

import type { Message } from "#compiled/chat/index.js";
import { messageToUserContent } from "#public/channels/chat-sdk/index.js";
import type { QuotedMessage } from "#public/channels/chat-sdk/reply-context.js";

/** Returns model-visible Photon content, or `undefined` for non-message events. */
export function photonInboundContent(message: Message): string | UserContent | undefined {
  const content = messageToUserContent(message);
  if (typeof content === "string") {
    return content.trim().length > 0 ? content : undefined;
  }
  return content.length > 0 ? content : undefined;
}

/**
 * The part of a Spectrum message that names what it replies to. A webhook
 * delivery carries the target's `contentPreview`; a gateway delivery carries
 * the target as a built message with text `content`.
 */
interface SpectrumReply {
  readonly content?: {
    readonly type?: unknown;
    readonly target?: {
      readonly content?: { readonly text?: unknown; readonly type?: unknown };
      readonly contentPreview?: unknown;
      readonly id?: unknown;
    };
  };
}

/**
 * Returns the message a Photon iMessage reply quotes. The adapter flattens a
 * reply to its new text, so this reads the target from the raw message.
 */
export function photonQuotedMessage(message: Message): QuotedMessage | undefined {
  const content = (message.raw as SpectrumReply | null | undefined)?.content;
  if (content?.type !== "reply") return undefined;
  const target = content.target;
  if (typeof target?.id !== "string" || target.id.length === 0) return undefined;
  const text =
    typeof target.contentPreview === "string"
      ? target.contentPreview
      : target.content?.type === "text" && typeof target.content.text === "string"
        ? target.content.text
        : undefined;
  return text === undefined ? { id: target.id } : { id: target.id, text };
}
