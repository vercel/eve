export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}
