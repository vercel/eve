/**
 * Small, unavoidable type guards used across the framework.
 *
 * Before adding a new guard: check whether `shared/json.ts`,
 * `shared/optional.ts`, or an existing standard-library predicate
 * already covers the case. This module exists specifically to stop
 * the same 3-line `typeof x === "object" && x !== null` pattern from
 * proliferating in every file that duck-types a field off an
 * `unknown` value.
 */

/**
 * Returns `true` when `value` is a non-null object that is not an
 * `Array`. Refines the type to `Record<string, unknown>` so callers
 * can duck-type fields without a subsequent `as { foo?: unknown }`
 * cast.
 *
 * Arrays are excluded because every use site in the codebase is
 * reading named fields (`value.message`, `value.errorId`,
 * `value.kind`, etc.) — none of which are meaningful on an array. If
 * you need "any non-null object including arrays", use
 * `typeof value === "object" && value !== null` inline.
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns `true` when `value` is a string with at least one
 * character. The zero-length check matters: empty strings routinely
 * fall out of optional-field projections (Slack `team_id`, HTTP
 * headers, JSON parse results) and should not be treated as a
 * meaningful value by display or correlation logic.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Returns `true` when `value` is a thenable — an object with a `then`
 * function. Used to reject async instrumentation metadata projectors
 * that accidentally return a Promise instead of a plain record.
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return isObject(value) && typeof value.then === "function";
}

/**
 * Returns `true` when `value` is a plain object record — `{}`,
 * `Object.create(null)`, or an object whose prototype is
 * `Object.prototype`. Class instances, `Map`, `Date`, and other
 * exotic objects are excluded even though `isObject` would accept
 * them.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
