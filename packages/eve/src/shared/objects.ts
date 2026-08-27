import { isPlainRecord } from "#shared/guards.js";

/**
 * Recursively merges plain records. Nested records are merged while arrays,
 * primitives, and exotic objects from `overrides` replace the base value.
 */
export function mergeObjects(
  base: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, ...overrides };

  for (const [key, overrideValue] of Object.entries(overrides ?? {})) {
    const baseValue = base[key];
    if (isPlainRecord(baseValue) && isPlainRecord(overrideValue)) {
      merged[key] = mergeObjects(baseValue, overrideValue);
    }
  }

  return merged;
}
