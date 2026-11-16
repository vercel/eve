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
 * Narrows a value to the callable members of its declared type.
 *
 * @typeParam T - Original union containing any callable members.
 * @param value - Value to inspect without invoking it.
 * @returns Whether the value is a function.
 */
export const isCallable = <T>(
  value: T
): value is Extract<T, (...args: never[]) => void> =>
  typeof value === "function";
