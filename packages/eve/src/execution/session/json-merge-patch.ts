import type { JsonObject } from "#shared/json.js";

/**
 * RFC 7386: an object in the patch merges into the target's object at that key, `null` removes the
 * key, and any other value replaces it. Patches for different keys of one map therefore compose.
 */
export function mergePatch(
  target: Record<string, unknown>,
  patch: JsonObject,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
    } else if (isPlainObject(value)) {
      const current = merged[key];
      merged[key] = mergePatch(isPlainObject(current) ? current : {}, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
