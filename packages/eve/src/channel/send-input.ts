import type { FilePart, UserContent } from "ai";

import type { SendPayload } from "#channel/routes.js";
import { serializeUrlFilePart } from "#internal/attachments/url-refs.js";

/** Normalizes the shorthand input forms accepted by channel and session sends. */
export function normalizeSendInput(input: string | UserContent | SendPayload): SendPayload {
  if (typeof input === "string") return { message: input };
  if (Array.isArray(input)) return { message: input };
  return input;
}

/**
 * Serializes file parts before input crosses the durable boundary: `URL`s
 * become `eve-url:` markers and bytes become `data:` URLs, so no world
 * serializer has to round-trip a `URL` or a typed array.
 */
export function serializeFilePartsInMessage(
  message: string | UserContent | undefined,
): string | UserContent | undefined {
  if (message === undefined || typeof message === "string") return message;

  let changed = false;
  const result = message.map((part): FilePart | typeof part => {
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
