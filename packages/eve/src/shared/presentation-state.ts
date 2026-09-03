import type { JsonValue } from "#shared/json.js";

export const MAX_PRESENTATION_STATE_BYTES = 32 * 1024;
export const MAX_PRESENTATION_STATE_DEPTH = 10;
export const MAX_PRESENTATION_STATE_ENTRIES = 500;

export function isPresentationStateKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/u.test(value);
}

export function isPresentationStateValue(value: unknown): value is JsonValue {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_PRESENTATION_STATE_BYTES) {
      return false;
    }
  } catch {
    return false;
  }
  let entries = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    if (depth > MAX_PRESENTATION_STATE_DEPTH || entries > MAX_PRESENTATION_STATE_ENTRIES) {
      return false;
    }
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    ) {
      return true;
    }
    if (Array.isArray(candidate)) {
      entries += candidate.length;
      return candidate.every((item) => visit(item, depth + 1));
    }
    if (typeof candidate !== "object" || candidate === null) return false;
    const values = Object.values(candidate);
    entries += values.length;
    return values.every((item) => visit(item, depth + 1));
  };
  return visit(value, 0);
}
