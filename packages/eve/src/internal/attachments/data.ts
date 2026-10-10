/**
 * Shared helpers for reading AI SDK `FilePart.data` values without
 * fetching remote resources.
 *
 * Every value has one meaning: typed arrays, base64 strings, `data:` URLs,
 * and tagged `data` or `text` shapes carry bytes; any other string or `URL`
 * with a scheme is a link the staging layer resolves; a provider reference
 * names a file the provider already holds. Anything else is unreadable.
 */

import { hasInternalRefScheme } from "#internal/attachments/url-refs.js";

/** What a `FilePart.data` value carries. */
export type FileData =
  | { readonly kind: "bytes"; readonly bytes: Buffer }
  | { readonly kind: "link"; readonly url: URL }
  | { readonly kind: "reference" }
  | { readonly kind: "unreadable" };

// Base64 has no colon, so a leading scheme always marks a link.
const SCHEME_PREFIX = /^[a-z][a-z\d+.-]*:/i;

const REFERENCE: FileData = { kind: "reference" };
const UNREADABLE: FileData = { kind: "unreadable" };

/**
 * Classifies one `FilePart.data` value. A string with a framework-internal
 * scheme is unreadable: only eve mints those refs, so a caller-supplied one
 * must never turn into a privileged read.
 */
export function readFileData(data: unknown): FileData {
  if (data instanceof Uint8Array) {
    return { bytes: Buffer.isBuffer(data) ? data : Buffer.from(data), kind: "bytes" };
  }
  if (data instanceof ArrayBuffer) {
    return { bytes: Buffer.from(new Uint8Array(data)), kind: "bytes" };
  }
  if (data instanceof URL) {
    return data.protocol === "data:" ? decodeDataUrl(data.href) : { kind: "link", url: data };
  }
  if (typeof data === "string") {
    return readStringData(data);
  }
  if (data === null || typeof data !== "object") {
    return UNREADABLE;
  }
  const tagged = data as { readonly type?: unknown; readonly [key: string]: unknown };
  switch (tagged.type) {
    case "data":
      return readFileData(tagged.data);
    case "url":
      return tagged.url instanceof URL || typeof tagged.url === "string"
        ? readFileData(tagged.url)
        : UNREADABLE;
    case "text":
      return typeof tagged.text === "string"
        ? { bytes: Buffer.from(tagged.text, "utf8"), kind: "bytes" }
        : UNREADABLE;
    case "reference":
      return REFERENCE;
    default:
      return isProviderReference(data) ? REFERENCE : UNREADABLE;
  }
}

/**
 * Whether `FilePart.data` is a link or unreadable, so eve must resolve it
 * before a provider sees it. Never decodes the payload.
 */
export function isUnresolvedFileData(data: unknown): boolean {
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) return false;
  if (typeof data === "string") return SCHEME_PREFIX.test(data) && !data.startsWith("data:");
  if (data instanceof URL) return data.protocol !== "data:";
  if (data === null || typeof data !== "object") return true;
  const tagged = data as { readonly type?: unknown; readonly [key: string]: unknown };
  switch (tagged.type) {
    case "data":
      return isUnresolvedFileData(tagged.data);
    case "url":
      return true;
    case "text":
      return typeof tagged.text !== "string";
    case "reference":
      return false;
    default:
      return !isProviderReference(data);
  }
}

/**
 * Returns the byte length of `FilePart.data` without performing any IO, or
 * `null` when only a fetch could tell.
 */
export function getKnownByteLength(data: unknown): number | null {
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (data instanceof URL) {
    return data.protocol === "data:" ? computeStringByteLength(data.href) : null;
  }
  if (typeof data !== "string") {
    return null;
  }
  if (data.startsWith("data:")) {
    return computeStringByteLength(data);
  }
  return SCHEME_PREFIX.test(data) ? null : estimateBase64ByteLength(data);
}

function readStringData(data: string): FileData {
  if (data.startsWith("data:")) {
    return decodeDataUrl(data);
  }
  if (SCHEME_PREFIX.test(data)) {
    if (hasInternalRefScheme(data)) return UNREADABLE;
    const url = URL.parse(data);
    return url === null ? UNREADABLE : { kind: "link", url };
  }
  // Bare strings are base64 payloads, matching AI SDK's `DataContent`.
  return { bytes: Buffer.from(data, "base64"), kind: "bytes" };
}

/** A bare AI SDK `ProviderReference`: provider names mapped to file ids. */
function isProviderReference(data: object): boolean {
  const values = Object.values(data);
  return values.length > 0 && values.every((value) => typeof value === "string");
}

function decodeDataUrl(value: string): FileData {
  const comma = value.indexOf(",");
  if (comma === -1) {
    return UNREADABLE;
  }
  const header = value.slice(5, comma);
  const body = value.slice(comma + 1);
  if (header.endsWith(";base64")) {
    return { bytes: Buffer.from(body, "base64"), kind: "bytes" };
  }
  try {
    return { bytes: Buffer.from(decodeURIComponent(body), "utf8"), kind: "bytes" };
  } catch {
    return UNREADABLE;
  }
}

function computeStringByteLength(value: string): number | null {
  const comma = value.indexOf(",");
  if (comma === -1) {
    return null;
  }
  const header = value.slice(5, comma);
  const body = value.slice(comma + 1);
  if (header.endsWith(";base64")) {
    return estimateBase64ByteLength(body);
  }
  // Percent-encoded UTF-8 payload: count the decoded octets, not the
  // percent-encoded string length.
  try {
    return Buffer.byteLength(decodeURIComponent(body), "utf8");
  } catch {
    return Buffer.byteLength(body, "utf8");
  }
}

function estimateBase64ByteLength(base64: string): number {
  const trimmed = base64.trimEnd();
  if (trimmed.length === 0) {
    return 0;
  }
  let padding = 0;
  if (trimmed.endsWith("==")) {
    padding = 2;
  } else if (trimmed.endsWith("=")) {
    padding = 1;
  }
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding);
}
