/**
 * Deep-copies messages for a strategy to edit freely. Plain objects, arrays and binary data are
 * copied; a `URL` is immutable and kept as it is, which `structuredClone` cannot do.
 */
export function cloneMessages<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneMessages) as T;
  if (value instanceof Uint8Array) return value.slice() as T;
  if (value instanceof ArrayBuffer) return value.slice(0) as T;
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneMessages(entry)]),
    ) as T;
  }
  return value;
}
