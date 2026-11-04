import { randomUUID as nodeRandomUUID } from "node:crypto";

// Random UUIDs in Node. `uuid.web.ts` is the twin for browsers and Web Workers; the package's
// `#platform/*` imports pick one by the `node` condition.

/** A random RFC 4122 version 4 UUID. */
export function randomUUID(): string {
  return nodeRandomUUID();
}
