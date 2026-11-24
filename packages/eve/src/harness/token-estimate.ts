import {
  estimateMediaTokens,
  readImageDimensions,
  type MediaMetadata,
} from "#internal/attachments/media-metadata.js";
import {
  decodeSandboxRef,
  inlinesSandboxRefAsBytes,
  isSandboxRefUrl,
} from "#internal/attachments/sandbox-refs.js";

const HEADER_BASE64_CHARS = 96 * 1024;
const REMOTE_URL = /^https?:\/\//i;

export function estimateTokens(value: unknown): number {
  let mediaTokens = 0;
  const serialized = JSON.stringify(value, (_key, candidate: unknown) => {
    if (isOpaqueProviderPart(candidate)) return withoutEncryptedContent(candidate);
    const media = estimateFilePartTokens(candidate);
    if (media === undefined) return candidate;
    mediaTokens += media;
    const { mediaType, type } = candidate as {
      readonly mediaType?: unknown;
      readonly type: unknown;
    };
    return { mediaType, type };
  });
  return Math.ceil(Buffer.byteLength(serialized ?? "") / 4) + mediaTokens;
}

interface OpaqueProviderPart {
  readonly type: "custom";
  readonly providerOptions: Readonly<Record<string, unknown>>;
}

function isOpaqueProviderPart(value: unknown): value is OpaqueProviderPart {
  if (value === null || typeof value !== "object") return false;
  const part = value as { readonly type?: unknown; readonly providerOptions?: unknown };
  return (
    part.type === "custom" &&
    part.providerOptions !== null &&
    typeof part.providerOptions === "object"
  );
}

function withoutEncryptedContent(part: OpaqueProviderPart): unknown {
  return {
    ...part,
    providerOptions: Object.fromEntries(
      Object.entries(part.providerOptions).map(([provider, options]) => [
        provider,
        options !== null && typeof options === "object"
          ? Object.fromEntries(
              Object.entries(options).filter(([key]) => key !== "encryptedContent"),
            )
          : options,
      ]),
    ),
  };
}

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
  if (isSandboxRefUrl(data)) return estimateSandboxRefTokens(data);
  if (data instanceof URL) return estimateRemoteTokens(mediaType);
  if (isTaggedFileData(data)) {
    switch (data.type) {
      case "data":
        return estimateInlineTokens(data.data, mediaType);
      case "url":
        return isSandboxRefUrl(data.url)
          ? estimateSandboxRefTokens(data.url)
          : estimateRemoteTokens(mediaType);
      case "reference":
        return estimateRemoteTokens(mediaType);
      default:
        return undefined;
    }
  }
  return estimateInlineTokens(data, mediaType);
}

function estimateSandboxRefTokens(url: URL): number | undefined {
  const ref = decodeSandboxRef(url);
  return inlinesSandboxRefAsBytes(ref) ? estimateMediaTokens(ref) : undefined;
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

function withHeaderMetadata(header: Uint8Array, mediaType: string, size: number): MediaMetadata {
  if (!mediaType.startsWith("image/")) return { mediaType, size };
  return { ...readImageDimensions(header), mediaType, size };
}
