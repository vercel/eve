const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MARKER = "... [truncated]";

export function telemetryByteLength(text: string): number {
  return encoder.encode(text).length;
}

export function truncateTelemetryText(text: string, maxBytes: number): string {
  const prefix = text.slice(0, maxBytes + 1);
  const bytes = encoder.encode(prefix);
  if (prefix.length === text.length && bytes.length <= maxBytes) return text;
  const marker = MARKER.slice(0, maxBytes);
  let end = Math.max(0, maxBytes - marker.length);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return decoder.decode(bytes.subarray(0, end)) + marker;
}
