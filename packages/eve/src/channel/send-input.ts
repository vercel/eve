import type { MessageContent, MessageFilePart } from "#shared/message-content.js";

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
    if (part.data instanceof URL && part.data.protocol !== "data:") {
      changed = true;
      return { ...part, data: serializeUrlFilePart(part.data) };
    }
    if (part.data instanceof Uint8Array || part.data instanceof ArrayBuffer) {
      changed = true;
      const base64 = Buffer.from(new Uint8Array(part.data)).toString("base64");
      return { ...part, data: `data:${part.mediaType};base64,${base64}` };
    }
    return part;
  });
  return changed ? result : message;
}
