import {
  estimateMediaTokens,
  readMediaMetadata,
  type MediaMetadata,
} from "#internal/attachments/media-metadata.js";
import {
  decodeSandboxRef,
  inlinesSandboxRefAsBytes,
  isSandboxRefUrl,
} from "#internal/attachments/sandbox-refs.js";

// Enough base64 to cover image headers, including a JPEG's EXIF block.
const HEADER_BASE64_CHARS = 96 * 1024;
const REMOTE_URL = /^https?:\/\//i;

/**
 * Rough token estimate: serialized JSON UTF-8 bytes / 4, with file parts
 * counted at what providers bill for media instead of their base64 length.
 * Bytes, not string length: a CJK character is one UTF-16 unit but about one
 * token, and its three UTF-8 bytes track that cost far better. Good enough
 * for deciding whether compaction is needed; the real token count comes back
 * from the model each step via
 * `CompactionConfig.lastKnownInputTokens`.
 *
 * Accepts any JSON-serializable value so callers can apply the same heuristic
 * to whole message arrays or individual content parts on one consistent ruler.
 */
export function estimateTokens(value: unknown): number {
  let mediaTokens = 0;
  const serialized = JSON.stringify(value, (_key, candidate: unknown) => {
    const media = estimateFilePartTokens(candidate);
    if (media === undefined) return candidate;
    mediaTokens += media;
    const { mediaType, type } = candidate as {
      readonly mediaType?: unknown;
      readonly type: unknown;
    };
    return { mediaType, type };
  });
  return Buffer.byteLength(serialized ?? "") / 4 + mediaTokens;
}

/**
 * Media tokens for a message file part or a `content` tool-output file part,
 * or `undefined` when the value is not one or renders as plain text.
 */
function estimateFilePartTokens(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const part = value as {
    readonly data?: unknown;
    readonly image?: unknown;
    readonly mediaType?: unknown;
    readonly type?: unknown;
  };
  if (part.type === "image" && part.image !== undefined) {
    return estimateFileDataTokens(
      part.image,
      typeof part.mediaType === "string" ? part.mediaType : "image/*",
    );
  }
  if ((part.type !== "file" && part.type !== "media") || typeof part.mediaType !== "string") {
    return undefined;
  }
  return estimateFileDataTokens(part.data, part.mediaType);
}

function estimateFileDataTokens(data: unknown, mediaType: string): number | undefined {
  if (isSandboxRefUrl(data)) {
    // Inbound attachments that hydrate as text references stay text.
    const ref = decodeSandboxRef(data);
    return inlinesSandboxRefAsBytes(ref) ? estimateMediaTokens(ref) : undefined;
  }
  if (data instanceof URL) return estimateRemoteTokens(mediaType);
  if (isTaggedFileData(data)) {
    switch (data.type) {
      case "data":
        return estimateInlineTokens(data.data, mediaType);
      case "url":
        return isSandboxRefUrl(data.url)
          ? estimateMediaTokens(decodeSandboxRef(data.url))
          : estimateRemoteTokens(mediaType);
      case "reference":
        return estimateRemoteTokens(mediaType);
      default:
        return undefined;
    }
  }
  return estimateInlineTokens(data, mediaType);
}

function isTaggedFileData(
  value: unknown,
): value is { readonly type: string; readonly data?: unknown; readonly url?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Uint8Array) &&
    !(value instanceof ArrayBuffer) &&
    typeof (value as { readonly type?: unknown }).type === "string"
  );
}

/** Providers fetch remote files themselves; only images have a known cost. */
function estimateRemoteTokens(mediaType: string): number | undefined {
  return mediaType.startsWith("image/") ? estimateMediaTokens({ mediaType, size: 0 }) : undefined;
}

function estimateInlineTokens(data: unknown, mediaType: string): number | undefined {
  if (typeof data === "string") {
    if (REMOTE_URL.test(data)) return estimateRemoteTokens(mediaType);
    const base64 = data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
    const size = Math.floor((base64.length * 3) / 4);
    return estimateMediaTokens(withHeaderMetadata(base64Header(base64), mediaType, size));
  }
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return estimateMediaTokens(withHeaderMetadata(bytes, mediaType, bytes.byteLength));
  }
  return undefined;
}

function base64Header(base64: string): Uint8Array {
  return Buffer.from(base64.slice(0, HEADER_BASE64_CHARS), "base64");
}

// Only image dimensions come from a header; page counts need the whole
// payload, so inline PDFs fall back to their size.
function withHeaderMetadata(header: Uint8Array, mediaType: string, size: number): MediaMetadata {
  if (!mediaType.startsWith("image/")) return { mediaType, size };
  return { ...readMediaMetadata(header, mediaType), size };
}
