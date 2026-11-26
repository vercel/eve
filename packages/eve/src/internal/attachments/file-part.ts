import { getKnownByteLength } from "#internal/attachments/data.js";
import { decodeSandboxRef, isSandboxRefUrl } from "#internal/attachments/sandbox-refs.js";
import {
  deserializeUrlFilePart,
  hasInternalRefScheme,
  isSerializedUrlFilePart,
} from "#internal/attachments/url-refs.js";

export interface DescribedFilePart {
  readonly filename?: string;
  readonly mediaType: string;
  readonly size?: number;
  readonly unavailable?: true;
  readonly url?: string;
}

export function describeFilePart(
  data: unknown,
  mediaType: string,
  filename: string | undefined,
): DescribedFilePart {
  if (isSandboxRefUrl(data)) {
    const ref = decodeSandboxRef(data);
    return buildFilePart({
      filename: basenameOf(filename ?? ref.path),
      mediaType: ref.mediaType,
      size: ref.size,
    });
  }
  if (isTaggedFileData(data)) {
    switch (data.type) {
      case "data":
        return buildFilePart({ filename, mediaType, size: byteLengthOf(data.data) });
      case "reference":
      case "text":
        return buildFilePart({ filename, mediaType });
      case "url":
        return buildFilePart({ filename, mediaType, url: clientUrl(data.url) });
    }
  }
  const size = byteLengthOf(data);
  if (size !== undefined) return buildFilePart({ filename, mediaType, size });
  return buildFilePart({ filename, mediaType, url: clientUrl(data) });
}

function buildFilePart(input: {
  readonly filename?: string;
  readonly mediaType: string;
  readonly size?: number;
  readonly url?: string;
}): DescribedFilePart {
  const part: { -readonly [K in keyof DescribedFilePart]: DescribedFilePart[K] } = {
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

function byteLengthOf(data: unknown): number | undefined {
  return getKnownByteLength(data) ?? undefined;
}

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
