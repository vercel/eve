import type { MessageContent } from "#shared/message-content.js";

import type { Message } from "#compiled/chat/index.js";
import { messageContentOf } from "#public/channels/chat-sdk/index.js";
import type { QuotedMessage } from "#public/channels/chat-sdk/reply-context.js";

export function photonInboundContent(message: Message): MessageContent | undefined {
  const content = messageContentOf(message);
  if (typeof content === "string") {
    return content.trim().length > 0 ? content : undefined;
  }
  return content.length > 0 ? content : undefined;
}

interface SpectrumReply {
  readonly content?: {
    readonly type?: unknown;
    readonly target?: {
      readonly content?: SpectrumContent;
      readonly contentPreview?: unknown;
      readonly direction?: unknown;
      readonly id?: unknown;
    };
  };
}

interface SpectrumContent {
  readonly content?: SpectrumContent;
  readonly items?: unknown;
  readonly text?: unknown;
  readonly type?: unknown;
}

export function photonQuotedMessage(message: Message): QuotedMessage | undefined {
  const content = (message.raw as SpectrumReply | null | undefined)?.content;
  if (content?.type !== "reply") return undefined;
  const target = content.target;
  if (typeof target?.id !== "string" || target.id.length === 0) return undefined;
  const text =
    typeof target.contentPreview === "string"
      ? target.contentPreview
      : spectrumText(target.content);
  const quoted: { id: string; text?: string; fromAgent?: boolean } = { id: target.id };
  if (text !== undefined) quoted.text = text;
  if (target.direction === "outbound") quoted.fromAgent = true;
  if (target.direction === "inbound") quoted.fromAgent = false;
  return quoted;
}

function spectrumText(content: SpectrumContent | undefined): string | undefined {
  if (content?.type === "text") return typeof content.text === "string" ? content.text : undefined;
  if (content?.type === "reply") return spectrumText(content.content);
  if (content?.type !== "group" || !Array.isArray(content.items)) return undefined;
  const texts = content.items.flatMap((item: { readonly content?: SpectrumContent }) => {
    const text = spectrumText(item?.content);
    return text ? [text] : [];
  });
  return texts.length > 0 ? texts.join("\n") : undefined;
}
