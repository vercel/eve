import { createHash } from "node:crypto";

// SHA-256 in Node. `sha256.web.ts` is the twin for runtimes without `node:crypto`; the package's
// `#platform/*` imports pick one by the `node` condition.

/** SHA-256 of `data` (strings as UTF-8). */
export function sha256(data: string | Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}
