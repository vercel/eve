import type { isDeepStrictEqual as NodeTwin } from "./deep-equal.js";

// Structural equality where there's no `node:util`, as `isDeepStrictEqual` answers it for the data
// eve compares: primitives by `Object.is`; arrays, typed arrays, maps, sets, dates, URLs and other
// objects by content (objects by their own enumerable keys, in any order); values of different
// prototypes never match. `deep-equal.ts` is the Node twin.

export const isDeepStrictEqual: typeof NodeTwin = (a, b) => deepEqual(a, b);

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  }
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) return bytesEqual(a, b);
  if (a instanceof Map && b instanceof Map) return mapsEqual(a, b);
  if (a instanceof Set && b instanceof Set) return setsEqual(a, b);
  if (a instanceof Date && b instanceof Date) return Object.is(a.getTime(), b.getTime());
  if (a instanceof URL && b instanceof URL) return a.href === b.href;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) => Object.hasOwn(b, key) && deepEqual(Reflect.get(a, key), Reflect.get(b, key)),
  );
}

function bytesEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
  const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** A member of `candidates` deeply equal to `value` that `used` doesn't hold yet. */
function takeMatch(candidates: Iterable<unknown>, value: unknown, used: Set<unknown>): boolean {
  for (const candidate of candidates) {
    if (!used.has(candidate) && deepEqual(value, candidate)) {
      used.add(candidate);
      return true;
    }
  }
  return false;
}

// Primitive keys and members match by identity, as a Map looks them up; object ones by content.
function mapsEqual(a: Map<unknown, unknown>, b: Map<unknown, unknown>): boolean {
  if (a.size !== b.size) return false;
  const used = new Set<unknown>();
  for (const [key, value] of a) {
    if (b.has(key)) {
      if (!deepEqual(value, b.get(key))) return false;
      continue;
    }
    if (typeof key !== "object" || key === null) return false;
    let found = false;
    for (const [otherKey, otherValue] of b) {
      if (!used.has(otherKey) && deepEqual(key, otherKey) && deepEqual(value, otherValue)) {
        used.add(otherKey);
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function setsEqual(a: Set<unknown>, b: Set<unknown>): boolean {
  if (a.size !== b.size) return false;
  const used = new Set<unknown>();
  for (const member of a) {
    if (b.has(member)) continue;
    if (typeof member !== "object" || member === null) return false;
    if (!takeMatch(b, member, used)) return false;
  }
  return true;
}
