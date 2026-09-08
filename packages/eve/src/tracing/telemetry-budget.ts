export const TELEMETRY_CONTENT_BYTES = 32 * 1024;
export const TELEMETRY_CONTEXT_BYTES = 64 * 1024;
export const TELEMETRY_CONTEXT_ATTRIBUTES = 64;
export const TELEMETRY_VALUE_NODES = 2048;
export const TELEMETRY_VALUE_DEPTH = 32;

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

/** Bounds traversal before serialization; the truncation envelope is always valid JSON. */
export function boundedTelemetryJson(
  value: unknown,
  maxBytes = TELEMETRY_CONTENT_BYTES,
  options: { readonly omitKeys?: ReadonlySet<string>; readonly truncate?: boolean } = {},
): string | undefined {
  let remaining = maxBytes;
  let nodes = 0;
  let truncated = false;
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (depth > TELEMETRY_VALUE_DEPTH || nodes > TELEMETRY_VALUE_NODES || remaining <= 0) {
      truncated = true;
      return MARKER;
    }
    if (typeof value === "string") {
      const text = truncateTelemetryText(value, Math.max(0, remaining));
      remaining -= telemetryByteLength(text) + 2;
      truncated ||= text !== value;
      return text;
    }
    if (value === null || typeof value !== "object") {
      remaining -= 16;
      return value;
    }
    if (seen.has(value)) {
      truncated = true;
      return "[circular]";
    }
    seen.add(value);
    const output: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {};
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (options.omitKeys?.has(key)) continue;
      if (remaining <= 0 || nodes >= TELEMETRY_VALUE_NODES) {
        truncated = true;
        break;
      }
      if (key.length > remaining) {
        truncated = true;
        break;
      }
      remaining -= telemetryByteLength(key.slice(0, maxBytes)) + 4;
      const child = visit((value as Record<string, unknown>)[key], depth + 1);
      if (Array.isArray(output)) output.push(child);
      else Object.defineProperty(output, key, { enumerable: true, value: child });
    }
    seen.delete(value);
    return output;
  };
  try {
    const projected = visit(value, 0);
    const full = JSON.stringify(projected);
    if (full === undefined) return undefined;
    if (!truncated && telemetryByteLength(full) <= maxBytes) return full;
    if (options.truncate === false) return undefined;
    let previewBudget = Math.floor(maxBytes / 2);
    while (previewBudget > 0) {
      const json = JSON.stringify({
        "eve.truncated": true,
        preview: truncateTelemetryText(full, previewBudget),
      });
      if (telemetryByteLength(json) <= maxBytes) return json;
      previewBudget = Math.floor(previewBudget / 2);
    }
    return undefined;
  } catch {
    return undefined;
  }
}
