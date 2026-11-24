export function hostBytes(bytes: Uint8Array): Uint8Array {
  return Buffer.from(bytes);
}

export function concatHostBytes(chunks: readonly Uint8Array[]): Uint8Array {
  return Buffer.concat(chunks);
}
