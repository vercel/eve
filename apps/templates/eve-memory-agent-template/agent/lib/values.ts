/**
 * Narrows an external value to a JavaScript string.
 *
 * @param value - Value received from a loosely typed boundary.
 * @returns Whether the value is a string.
 */
export const isString = (value: unknown): value is string =>
  typeof value === "string";
