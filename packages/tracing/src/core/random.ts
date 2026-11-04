// Random ids from the global Web Crypto API, which Node (>= 24, as this package requires),
// browsers and Web Workers all have, so the library imports no `node:crypto`.

/** `bytes` random bytes as lowercase hex. */
export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function randomUUID(): string {
  return crypto.randomUUID();
}
