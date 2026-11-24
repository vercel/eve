import { hasInternalRefScheme } from "#internal/attachments/url-refs.js";
import { fromBase64, utf8ByteLength, utf8Bytes } from "#shared/bytes.js";
import { hostBytes } from "#runtime-env/host-bytes.js";

export type FileData =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "link"; readonly url: URL }
  | { readonly kind: "reference" }
  | { readonly kind: "unreadable" };

const SCHEME_PREFIX = /^[a-z][a-z\d+.-]*:/i;

const REFERENCE: FileData = { kind: "reference" };
const UNREADABLE: FileData = { kind: "unreadable" };

export function readFileData(data: unknown): FileData {
  if (data instanceof Uint8Array) {
    return { bytes: hostBytes(data), kind: "bytes" };
  }
  if (data instanceof ArrayBuffer) {
    return { bytes: hostBytes(new Uint8Array(data)), kind: "bytes" };
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
        ? { bytes: hostBytes(utf8Bytes(tagged.text)), kind: "bytes" }
        : UNREADABLE;
    case "reference":
      return REFERENCE;
    default:
      return isProviderReference(data) ? REFERENCE : UNREADABLE;
  }
}

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
  return { bytes: hostBytes(fromBase64(data)), kind: "bytes" };
}

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
    return { bytes: hostBytes(fromBase64(body)), kind: "bytes" };
  }
  try {
    return { bytes: hostBytes(utf8Bytes(decodeURIComponent(body))), kind: "bytes" };
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
  try {
    return utf8ByteLength(decodeURIComponent(body));
  } catch {
    return utf8ByteLength(body);
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
