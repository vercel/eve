import { createHash } from "node:crypto";

export function sha256(data: string | Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}
