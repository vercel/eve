/**
 * Narrows an external value to a JavaScript string.
 *
 * @param value - Value received from a loosely typed boundary.
 * @returns Whether the value is a string.
 */
export const isString = (value: unknown): value is string =>
  typeof value === "string";
/**
 * Narrows an external value to a JavaScript number, including NaN and infinities.
 *
 * @param value - Value received from a loosely typed boundary.
 * @returns Whether the value has JavaScript's number type.
 */
export const isNumber = (value: unknown): value is number =>
  typeof value === "number";
/**
 * Narrows a value to a non-null object; arrays also satisfy this guard.
 *
 * @typeParam T - Original value type retained after narrowing.
 * @param value - Value to inspect without coercion.
 * @returns Whether the value is a non-null object.
 */
export const isObject = <T>(value: T): value is T & object =>
  typeof value === "object" && value !== null;
/**
 * Narrows an external value to a JavaScript bigint.
 *
 * @param value - Value received from a loosely typed boundary.
 * @returns Whether the value is a bigint.
 */
export const isBigInt = (value: unknown): value is bigint =>
  typeof value === "bigint";
/**
 * Adds or replaces one entry, keeping only the most recently added ones.
 *
 * @typeParam T - Stored value type.
 * @param record - Current entries, oldest first.
 * @param key - Entry to add, or to move to the end when it already exists.
 * @param value - Value to store.
 * @param limit - Most entries to keep.
 * @returns A new record with at most `limit` entries.
 * @remarks Relies on insertion order, so keys must not be integer-like strings.
 */
export const withRecentEntry = <T>(
  record: Readonly<Record<string, T>>,
  key: string,
  value: T,
  limit: number
): Record<string, T> =>
  Object.fromEntries(
    [
      ...Object.entries(record).filter(([existing]) => existing !== key),
      [key, value] as const,
    ].slice(-limit)
  );
