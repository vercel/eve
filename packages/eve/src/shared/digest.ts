import { sha256 } from "#platform/sha256.js";
import { toBase64Url, toHex } from "#shared/bytes.js";

// SHA-256 digests in the encodings eve writes, as `createHash("sha256").digest(...)` writes them,
// on any platform.

/** SHA-256 of `data` (strings as UTF-8), as lowercase hex. */
export function sha256Hex(data: string | Uint8Array): string {
  return toHex(sha256(data));
}

/** SHA-256 of `data` (strings as UTF-8), as unpadded base64url. */
export function sha256Base64Url(data: string | Uint8Array): string {
  return toBase64Url(sha256(data));
}
