/**
 * Shared JSON primitive used by public eve APIs that need to declare
 * author-supplied values as JSON-serializable.
 *
 * The canonical use site is {@link AuthorizationDefinition}, whose
 * `State` type is constrained to {@link JsonValue} so that state
 * journaled by WDK between `startAuthorization` and
 * `completeAuthorization` is guaranteed round-trippable through a
 * serializer. Kept in a dedicated module so any future public
 * interface with the same serialization requirement can reuse it
 * without depending on a connection-specific module.
 */

/**
 * Recursive type describing any JSON-serializable value.
 *
 * Accepted: `string`, `number`, `boolean`, `null`, arrays of
 * {@link JsonValue}, and objects whose string keys map to
 * {@link JsonValue}. All containers are marked `readonly` so authored
 * code treats the value as immutable at the type level.
 *
 * Rejected (at compile time): `undefined`, functions, `Date`, class
 * instances, `Map`, `Set`, `bigint`, and symbols. These cannot survive
 * a `JSON.stringify(...)` / `JSON.parse(...)` round trip and must not
 * cross a durable step boundary.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
