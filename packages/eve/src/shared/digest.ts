import { sha256 } from "#runtime-env/sha256.js";
import { toBase64Url, toHex } from "#shared/bytes.js";

export function sha256Hex(data: string | Uint8Array): string {
  return toHex(sha256(data));
}

export function sha256Base64Url(data: string | Uint8Array): string {
  return toBase64Url(sha256(data));
}
