/**
 * Narrows an external value to a JavaScript string.
 *
 * @param value - Value received from a loosely typed boundary.
 * @returns Whether the value is a string.
 */
export const isString = (value: unknown): value is string =>
  typeof value === "string";

/**
 * Checks for a string with at least one character.
 *
 * @param value - Optional string from an external payload or the environment.
 * @returns Whether the value is a nonempty string.
 */
export const isNonEmptyString = (
  value: string | null | undefined
): value is string => value !== undefined && value !== null && value !== "";

/**
 * Normalizes a missing or empty string to null.
 *
 * @param value - Optional string from an external payload.
 * @returns The value when it's nonempty, otherwise null.
 */
export const nonEmpty = (value: string | null | undefined): string | null =>
  isNonEmptyString(value) ? value : null;
