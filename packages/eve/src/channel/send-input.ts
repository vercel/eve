import type { MessageContent } from "#shared/message-content.js";
import { type SessionHistoryMessage, validateSessionHistory } from "#shared/session-history.js";

import type { SendPayload } from "#channel/routes.js";
import { serializeUrlFilePart } from "#internal/attachments/url-refs.js";

export function normalizeSendInput(input: MessageContent | SendPayload): SendPayload {
  return isMessageContent(input) ? { message: input } : input;
}

function isMessageContent(input: MessageContent | SendPayload): input is MessageContent {
  return typeof input === "string" || Array.isArray(input);
}

export function serializeFilePartsInMessage<T extends MessageContent | undefined>(message: T): T {
  if (message === undefined || typeof message === "string") return message;

  let changed = false;
  const result = message.map((part) => {
    if (part.type !== "file") return part;
    if (part.data instanceof URL) {
      changed = true;
      return {
        ...part,
        data: part.data.protocol === "data:" ? part.data.href : serializeUrlFilePart(part.data),
      };
    }
    if (part.data instanceof Uint8Array || part.data instanceof ArrayBuffer) {
      changed = true;
      const base64 = Buffer.from(new Uint8Array(part.data)).toString("base64");
      return { ...part, data: `data:${part.mediaType};base64,${base64}` };
    }
    return part;
  });
  return (changed ? result : message) as T;
}

export function prepareSessionHistory(
  history: unknown,
): readonly SessionHistoryMessage[] | undefined {
  const validated = validateSessionHistory(history);
  if (validated === undefined || validated.length === 0) return validated;
  return validated.map((message) =>
    message.role === "user" && message.parts !== undefined
      ? { ...message, parts: serializeFilePartsInMessage(message.parts) }
      : message,
  );
}
