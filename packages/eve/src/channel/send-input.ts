import type { MessageContent, MessageFilePart } from "#shared/message-content.js";
import type { SessionHistoryMessage } from "#shared/session-history.js";

import type { SendPayload } from "#channel/routes.js";
import { serializeUrlFilePart } from "#internal/attachments/url-refs.js";

export function normalizeSendInput(input: MessageContent | SendPayload): SendPayload {
  return isMessageContent(input) ? { message: input } : input;
}

function isMessageContent(input: MessageContent | SendPayload): input is MessageContent {
  return typeof input === "string" || Array.isArray(input);
}

export function serializeFilePartsInMessage(
  message: MessageContent | undefined,
): MessageContent | undefined {
  if (message === undefined || typeof message === "string") return message;

  let changed = false;
  const result = message.map((part): MessageFilePart | typeof part => {
    if (part.type !== "file") return part;
    const serialized = serializeFilePart(part);
    if (serialized !== part) changed = true;
    return serialized;
  });
  return changed ? result : message;
}

export function serializeFilePartsInHistory(
  history: readonly SessionHistoryMessage[] | undefined,
): readonly SessionHistoryMessage[] | undefined {
  if (history === undefined || history.length === 0) return history;

  let changed = false;
  const result = history.map((message): SessionHistoryMessage => {
    if (message.role !== "user" || message.parts === undefined) return message;
    let partsChanged = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "file") return part;
      const serialized = serializeFilePart(part);
      if (serialized !== part) partsChanged = true;
      return serialized;
    });
    if (!partsChanged) return message;
    changed = true;
    return { ...message, parts };
  });
  return changed ? result : history;
}

function serializeFilePart(part: MessageFilePart): MessageFilePart {
  if (part.data instanceof URL && part.data.protocol !== "data:") {
    return { ...part, data: serializeUrlFilePart(part.data) };
  }
  if (part.data instanceof Uint8Array || part.data instanceof ArrayBuffer) {
    const base64 = Buffer.from(new Uint8Array(part.data)).toString("base64");
    return { ...part, data: `data:${part.mediaType};base64,${base64}` };
  }
  return part;
}
