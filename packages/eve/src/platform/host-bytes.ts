// Bytes as this host hands them to authored code: Node's `Buffer`, which a Node author can call
// `toString("base64")` and the like on. `host-bytes.web.ts` is the browser's twin, which has no
// `Buffer`; the package's `#platform/*` imports pick one by the `node` condition.

/** A copy of `bytes`, as this host's byte type. */
export function hostBytes(bytes: Uint8Array): Uint8Array {
  return Buffer.from(bytes);
}

/** `chunks` joined, as this host's byte type. */
export function concatHostBytes(chunks: readonly Uint8Array[]): Uint8Array {
  return Buffer.concat(chunks);
}
