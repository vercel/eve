/**
 * Byte-level media facts read once when a file enters the session, so token
 * estimates never need the payload again.
 */

/** Facts about one file payload that drive its token estimate. */
export interface MediaMetadata {
  readonly mediaType: string;
  readonly size: number;
  readonly width?: number;
  readonly height?: number;
  readonly pages?: number;
}

// Anthropic bills one visual token per 28px patch and caps each image at
// 4,784; OpenAI's 32px patches times its 1.2 multiplier land just under the
// 28px count, and Gemini caps images at 2,240. One patch rule under the
// largest common cap stays within the right magnitude for every provider.
const IMAGE_PATCH_PX = 28;
const MAX_IMAGE_TOKENS = 4_784;

// Providers render each PDF page as text plus a page image; ~3,000 tokens per
// page is the upper end of that range.
const PDF_PAGE_TOKENS = 3_000;

/** Reads the dimensions or page count of a payload, as far as its header allows. */
export function readMediaMetadata(bytes: Uint8Array, mediaType: string): MediaMetadata {
  const metadata = { mediaType, size: bytes.byteLength };
  if (mediaType.startsWith("image/")) {
    const dimensions = readImageDimensions(bytes);
    return dimensions === undefined ? metadata : { ...metadata, ...dimensions };
  }
  if (mediaType === "application/pdf") {
    const pages = countPdfPages(bytes);
    return pages === undefined ? metadata : { ...metadata, pages };
  }
  return metadata;
}

/**
 * Estimates the input tokens a provider bills for one file. Images and PDFs
 * use provider-style costs; anything else falls back to the size of its
 * base64 text, which is how text-only providers receive it.
 */
export function estimateMediaTokens(metadata: MediaMetadata): number {
  if (metadata.mediaType.startsWith("image/")) {
    if (metadata.width === undefined || metadata.height === undefined) return MAX_IMAGE_TOKENS;
    const patches =
      Math.ceil(metadata.width / IMAGE_PATCH_PX) * Math.ceil(metadata.height / IMAGE_PATCH_PX);
    return Math.min(patches, MAX_IMAGE_TOKENS);
  }
  if (metadata.mediaType === "application/pdf" && metadata.pages !== undefined) {
    return metadata.pages * PDF_PAGE_TOKENS;
  }
  return Math.ceil(metadata.size / 3);
}

const GENERIC_MEDIA_TYPE = "application/octet-stream";
const PDF_MEDIA_TYPE = "application/pdf";
// The PDF header may follow up to 1 KiB of leading bytes.
const PDF_HEADER_WINDOW = 1024;

/**
 * The media type a staged file carries: the format its bytes prove for an
 * image, PDF, or untyped file, or the declared type otherwise. A declared
 * PNG, JPEG, GIF, WebP, or PDF that the bytes don't confirm becomes
 * `application/octet-stream`, so no provider receives bytes it would reject.
 */
export function verifyMediaType(bytes: Uint8Array, declared: string): string {
  const normalized = declared.toLowerCase();
  const checkable =
    normalized.startsWith("image/") ||
    normalized === PDF_MEDIA_TYPE ||
    normalized === GENERIC_MEDIA_TYPE;
  if (!checkable) return declared;
  const detected =
    detectImageMediaType(bytes) ?? (hasPdfHeader(bytes) ? PDF_MEDIA_TYPE : undefined);
  if (detected !== undefined) return detected;
  return VERIFIABLE_MEDIA_TYPES.has(normalized) ? GENERIC_MEDIA_TYPE : declared;
}

/** The image formats eve can verify from bytes, and that every major provider reads. */
export const INLINE_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const VERIFIABLE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  ...INLINE_IMAGE_MEDIA_TYPES,
  "image/jpg",
  PDF_MEDIA_TYPE,
]);

function hasPdfHeader(bytes: Uint8Array): boolean {
  const head = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    Math.min(bytes.byteLength, PDF_HEADER_WINDOW),
  );
  return head.includes("%PDF-", 0, "latin1");
}

/** Names the PNG, GIF, JPEG, or WebP format its leading bytes identify. */
export function detectImageMediaType(bytes: Uint8Array): string | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, end: number) => readAscii(bytes, start, end);

  if (
    bytes.byteLength >= 8 &&
    view.getUint32(0) === 0x89504e47 &&
    view.getUint32(4) === 0x0d0a1a0a
  ) {
    return "image/png";
  }
  if (bytes.byteLength >= 3 && view.getUint16(0) === 0xffd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** Reads PNG, GIF, JPEG, or WebP dimensions from the leading bytes. */
export function readImageDimensions(
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, end: number) => readAscii(bytes, start, end);

  if (bytes.byteLength >= 24 && view.getUint32(0) === 0x89504e47) {
    return dimensions(view.getUint32(16), view.getUint32(20));
  }
  if (bytes.byteLength >= 10 && ascii(0, 4) === "GIF8") {
    return dimensions(view.getUint16(6, true), view.getUint16(8, true));
  }
  if (bytes.byteLength >= 4 && view.getUint16(0) === 0xffd8) {
    return readJpegDimensions(bytes, view);
  }
  if (bytes.byteLength >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    const chunk = ascii(12, 16);
    if (chunk === "VP8 ") {
      return dimensions(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    }
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true);
      return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (chunk === "VP8X") {
      return dimensions(readUint24(bytes, 24) + 1, readUint24(bytes, 27) + 1);
    }
  }
  return undefined;
}

function readJpegDimensions(
  bytes: Uint8Array,
  view: DataView,
): { readonly width: number; readonly height: number } | undefined {
  let offset = 2;
  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // SOF0–SOF15 carry the frame size, except DHT (C4), JPG (C8), and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return dimensions(view.getUint16(offset + 7), view.getUint16(offset + 5));
    }
    offset += 2 + view.getUint16(offset + 2);
  }
  return undefined;
}

function countPdfPages(bytes: Uint8Array): number | undefined {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  // Page objects in compressed object streams are invisible here; the
  // estimate then falls back to the payload size.
  const pages = text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
  return pages > 0 ? pages : undefined;
}

function readAscii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, Math.min(end, bytes.byteLength)));
}

function readUint24(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function dimensions(
  width: number,
  height: number,
): { readonly width: number; readonly height: number } | undefined {
  return width > 0 && height > 0 ? { height, width } : undefined;
}
