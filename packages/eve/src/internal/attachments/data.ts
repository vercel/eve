/**
 * Shared helpers for decoding AI SDK `FilePart.data` values into raw
 * bytes and inspecting their size without fetching remote resources.
 *
 * URL-shaped inputs that require IO return `null`; channel attachment
 * refs are resolved explicitly by the staging layer.
 */

import { isAttachmentRefUrl, parseAttachmentRef } from "#internal/attachments/refs.js";

/**
 * Converts any inline AI SDK `FilePart.data` value into raw bytes.
 *
 * Returns `null` for every URL-shaped input the caller is expected to
 * handle out-of-band, including `eve-attachment:` refs and remote URLs.
 */
export async function fileDataToBytes(data: unknown): Promise<Buffer | null> {
  // Buffer extends Uint8Array — check it first so genuine Buffer inputs
  // short-circuit to identity instead of an unnecessary copy.
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
    return data;
  }

  if (data instanceof Uint8Array) {
    return Buffer.from(data);
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data));
  }

  if (typeof data === "string") {
    return decodeStringData(data);
  }

  if (data instanceof URL) {
    if (data.protocol === "data:") {
      return decodeStringData(data.href);
    }
    // Every other URL scheme (including eve-attachment: and http(s):)
    // requires IO the caller must own.
    return null;
  }

  return null;
}

/**
 * Returns the byte length of `FilePart.data` without performing any IO.
 */
export function getKnownByteLength(data: unknown): number | null {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
    return data.byteLength;
  }

  if (data instanceof Uint8Array) {
    return data.byteLength;
  }

  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }

  if (typeof data === "string") {
    return computeStringByteLength(data);
  }

  if (isAttachmentRefUrl(data)) {
    const ref = parseAttachmentRef(data);
    return ref.size ?? null;
  }

  if (data instanceof URL) {
    if (data.protocol === "data:") {
      return computeStringByteLength(data.href);
    }
    return null;
  }

  return null;
}

function decodeStringData(value: string): Buffer | null {
  if (value.startsWith("data:")) {
    const comma = value.indexOf(",");
    if (comma === -1) {
      return null;
    }
    const header = value.slice(5, comma);
    const body = value.slice(comma + 1);
    if (header.endsWith(";base64")) {
      return Buffer.from(body, "base64");
    }
    return Buffer.from(decodeURIComponent(body), "utf8");
  }

  if (/^https?:\/\//.test(value)) {
    return null;
  }

  // Bare strings are treated as base64 payloads, matching AI SDK's
  // `DataContent` convention.
  return Buffer.from(value, "base64");
}

function computeStringByteLength(value: string): number | null {
  if (value.startsWith("data:")) {
    const comma = value.indexOf(",");
    if (comma === -1) {
      return null;
    }
    const header = value.slice(5, comma);
    const body = value.slice(comma + 1);
    if (header.endsWith(";base64")) {
      return estimateBase64ByteLength(body);
    }
    // Percent-encoded UTF-8 payload — estimate by decoding; the bytes
    // we care about are the final UTF-8 octets, not the percent-encoded
    // string length.
    try {
      return Buffer.byteLength(decodeURIComponent(body), "utf8");
    } catch {
      return Buffer.byteLength(body, "utf8");
    }
  }

  if (/^https?:\/\//.test(value)) {
    return null;
  }

  return estimateBase64ByteLength(value);
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
