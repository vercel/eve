import type { FilePart, UserContent } from "ai";

import type { SendPayload } from "#channel/routes.js";
import { serializeUrlFilePart } from "#internal/attachments/url-refs.js";

/** Normalizes the shorthand input forms accepted by channel and session sends. */
export function normalizeSendInput(input: string | UserContent | SendPayload): SendPayload {
  if (typeof input === "string") return { message: input };
  if (Array.isArray(input)) return { message: input };
  return input;
}

/** Serializes non-data URL file parts before input crosses the durable boundary. */
export function serializeUrlFilePartsInMessage(
  message: string | UserContent | undefined,
): string | UserContent | undefined {
  if (message === undefined || typeof message === "string") return message;

  let changed = false;
  const result = message.map((part): FilePart | typeof part => {
    if (part.type === "file" && part.data instanceof URL && part.data.protocol !== "data:") {
      changed = true;
      return { ...part, data: serializeUrlFilePart(part.data) };
    }
    return part;
  });
  return changed ? result : message;
}
