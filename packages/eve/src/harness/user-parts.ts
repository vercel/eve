import {
  deserializeUrlFilePart,
  hasInternalRefScheme,
  isSerializedUrlFilePart,
} from "#internal/attachments/url-refs.js";
import { getKnownByteLength } from "#internal/attachments/data.js";
import { decodeSandboxRef, isSandboxRefUrl } from "#internal/attachments/sandbox-refs.js";
import type { UserPart } from "#protocol/session-events/envelope.js";
import type { MessageContent } from "#shared/message-content.js";

// What a person sent, as `delivery.consumed` reports it: text, and files as metadata. Bytes
// never reach the stream. A file keeps a URL only when a client can resolve it over http(s);
// otherwise it's marked unavailable until an attachment store can serve it.

/** The parts of one message. */
export function userPartsOf(message: MessageContent): readonly UserPart[] {
  if (typeof message === "string") return [{ kind: "text", text: message }];
  const parts: UserPart[] = [];
  for (const part of message) {
    parts.push(
      part.type === "text"
        ? { kind: "text", text: part.text }
        : filePart(part.data, part.mediaType, part.filename),
    );
  }
  return parts;
}

function filePart(data: unknown, mediaType: string, filename: string | undefined): UserPart {
  if (isSandboxRefUrl(data)) {
    const ref = decodeSandboxRef(data);
    return file({
      filename: basenameOf(filename ?? ref.path),
      mediaType: ref.mediaType,
      size: ref.size,
    });
  }
  if (isTaggedFileData(data)) {
    switch (data.type) {
      case "data":
        return file({ filename, mediaType, size: byteLengthOf(data.data) });
      case "reference":
      case "text":
        return file({ filename, mediaType });
      case "url":
        return file({ filename, mediaType, url: clientUrl(data.url) });
    }
  }
  const size = byteLengthOf(data);
  if (size !== undefined) return file({ filename, mediaType, size });
  return file({ filename, mediaType, url: clientUrl(data) });
}

function file(input: {
  readonly filename?: string;
  readonly mediaType: string;
  readonly size?: number;
  readonly url?: string;
}): UserPart {
  const part: {
    -readonly [K in keyof Extract<UserPart, { kind: "file" }>]: Extract<
      UserPart,
      { kind: "file" }
    >[K];
  } = {
    kind: "file",
    mediaType: input.mediaType,
  };
  if (input.filename !== undefined) part.filename = input.filename;
  if (input.size !== undefined) part.size = input.size;
  if (input.url !== undefined) part.url = input.url;
  else part.unavailable = true;
  return part;
}

function isTaggedFileData(
  data: unknown,
): data is
  | { readonly type: "data"; readonly data: unknown }
  | { readonly type: "reference"; readonly reference: unknown }
  | { readonly type: "text"; readonly text: unknown }
  | { readonly type: "url"; readonly url: unknown } {
  if (data === null || typeof data !== "object") return false;
  const type = (data as { readonly type?: unknown }).type;
  return type === "data" || type === "reference" || type === "text" || type === "url";
}

/** What an inline payload weighs, read without decoding it: bytes, a `data:` URL, or base64. */
function byteLengthOf(data: unknown): number | undefined {
  return getKnownByteLength(data) ?? undefined;
}

/** A URL a client can fetch over http(s); never a `data:` URL, which would put bytes on the stream. */
function clientUrl(data: unknown): string | undefined {
  if (isSerializedUrlFilePart(data)) {
    try {
      return httpUrl(deserializeUrlFilePart(data));
    } catch {
      return undefined;
    }
  }
  if (data instanceof URL) return httpUrl(data);
  if (typeof data !== "string" || hasInternalRefScheme(data) || data.startsWith("data:")) {
    return undefined;
  }
  try {
    return httpUrl(new URL(data));
  } catch {
    return undefined;
  }
}

function httpUrl(url: URL): string | undefined {
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
}

function basenameOf(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const segment = normalized.slice(normalized.lastIndexOf("/") + 1);
  return segment.length > 0 ? segment : path;
}
