/** Narrowing helpers for the JSON a scenario test reads back from a live server. */

/** `value` as a plain object, or a thrown error naming what it should have been. */
export function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} was not an object.`);
  }
  return value as Record<string, unknown>;
}

/** `value` as a non-empty string, or a thrown error naming what it should have been. */
export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} was not a non-empty string.`);
  }
  return value;
}
