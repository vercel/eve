import { createHash } from "node:crypto";

// SHA-256 digests in the encodings eve writes.

/** SHA-256 of `data` (strings as UTF-8), as lowercase hex. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 of `data` (strings as UTF-8), as unpadded base64url. */
export function sha256Base64Url(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("base64url");
}
