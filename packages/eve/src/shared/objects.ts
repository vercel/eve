import { isPlainRecord } from "#shared/guards.js";

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
