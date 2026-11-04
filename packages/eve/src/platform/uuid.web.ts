// Random UUIDs where there's no `node:crypto`: every browser and Web Worker has Web Crypto's.
// `uuid.ts` is the Node twin; the package's `#platform/*` imports pick one by the `node` condition.

/** A random RFC 4122 version 4 UUID. */
export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}
