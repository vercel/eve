/**
 * Structural deltas between serializable values.
 *
 * `applyValueDelta(base, diffValue(base, next))` rebuilds `next` as a
 * serializer sees it: the same entries, in the same key order, including
 * entries whose value is `undefined`. Plain objects and arrays change entry by
 * entry, so the result shares every unchanged entry with `base`. Any other
 * value is compared by identity and carried whole when it differs, so such
 * values must be replaced rather than edited in place.
 */
export type ValueDelta =
  | { readonly kind: "value"; readonly value: unknown }
  | (EntryChanges & {
      readonly kind: "object";
      /**
       * The next object's keys, present only when they are not the base's keys
       * followed by the added ones: an entry was removed or the order changed.
       */
      readonly keys?: readonly string[];
    })
  | (EntryChanges & { readonly kind: "array"; readonly length: number });

/** Entry changes by key or index: whole next values in `set`, nested deltas in `patch`. */
interface EntryChanges {
  readonly patch?: Readonly<Record<string, ValueDelta>>;
  readonly set?: Readonly<Record<string, unknown>>;
}

type PlainObject = Readonly<Record<string, unknown>>;

/**
 * Copies every plain object and array in `value` and keeps any other value by
 * reference, so editing `value` in place afterwards leaves the copy intact.
 */
export function snapshotValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry: unknown) => snapshotValue(entry)) as T;
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).map((key) => [key, snapshotValue(value[key])])) as T;
}

/** The delta from `base` to `next`, or `undefined` when they are equal. */
export function diffValue(base: unknown, next: unknown): ValueDelta | undefined {
  if (Object.is(base, next)) return undefined;
  if (Array.isArray(base) && Array.isArray(next)) return diffArray(base, next);
  if (isPlainObject(base) && isPlainObject(next)) return diffObject(base, next);
  return { kind: "value", value: next };
}

/** Applies a delta from {@link diffValue} to the value it was computed against. */
export function applyValueDelta<T>(base: T, delta: ValueDelta | undefined): T {
  if (delta === undefined) return base;
  switch (delta.kind) {
    case "value":
      return delta.value as T;
    case "array": {
      if (!Array.isArray(base)) throw deltaMismatch("an array");
      const next = base.slice(0, delta.length);
      // Integer keys enumerate in ascending order, so appended entries stay contiguous.
      for (const [index, value] of Object.entries(delta.set ?? {})) next[Number(index)] = value;
      for (const [index, change] of Object.entries(delta.patch ?? {})) {
        next[Number(index)] = applyValueDelta(base[Number(index)], change);
      }
      return next as T;
    }
    case "object": {
      if (!isPlainObject(base)) throw deltaMismatch("an object");
      const baseKeys = Object.keys(base);
      const set = delta.set ?? {};
      const patch = delta.patch ?? {};
      const keys = delta.keys ?? impliedKeys(baseKeys, set);
      return Object.fromEntries(
        keys.map((key) => {
          if (Object.hasOwn(set, key)) return [key, set[key]];
          if (Object.hasOwn(patch, key)) return [key, applyValueDelta(base[key], patch[key])];
          return [key, base[key]];
        }),
      ) as T;
    }
  }
}

function diffArray(base: readonly unknown[], next: readonly unknown[]): ValueDelta | undefined {
  const set: [string, unknown][] = [];
  const patch: [string, ValueDelta][] = [];
  let kept = 0;
  for (let index = 0; index < next.length; index++) {
    // An entry-wise change cannot express a hole, so the array travels whole.
    if (!(index in next) || (index < base.length && !(index in base))) {
      return { kind: "value", value: next };
    }
    if (index >= base.length) {
      set.push([String(index), next[index]]);
      continue;
    }
    const change = diffValue(base[index], next[index]);
    if (change === undefined) kept++;
    else if (change.kind === "value") set.push([String(index), change.value]);
    else patch.push([String(index), change]);
  }
  if (set.length === 0 && patch.length === 0 && next.length === base.length) return undefined;
  if (kept === 0 && patch.length === 0) return { kind: "value", value: next };
  return { ...entryChanges(set, patch), kind: "array", length: next.length };
}

function diffObject(base: PlainObject, next: PlainObject): ValueDelta | undefined {
  const baseKeys = Object.keys(base);
  const nextKeys = Object.keys(next);
  const set: [string, unknown][] = [];
  const patch: [string, ValueDelta][] = [];
  let kept = 0;
  for (const key of nextKeys) {
    if (!Object.hasOwn(base, key)) {
      set.push([key, next[key]]);
      continue;
    }
    const change = diffValue(base[key], next[key]);
    if (change === undefined) kept++;
    else if (change.kind === "value") set.push([key, change.value]);
    else patch.push([key, change]);
  }
  const changes = entryChanges(set, patch);
  const keysChanged = !sameKeys(impliedKeys(baseKeys, changes.set ?? {}), nextKeys);
  if (set.length === 0 && patch.length === 0 && !keysChanged) return undefined;
  if (kept === 0 && patch.length === 0) return { kind: "value", value: next };
  return keysChanged
    ? { ...changes, keys: nextKeys, kind: "object" }
    : { ...changes, kind: "object" };
}

function entryChanges(
  set: readonly (readonly [string, unknown])[],
  patch: readonly (readonly [string, ValueDelta])[],
): EntryChanges {
  const changes: { -readonly [K in keyof EntryChanges]: EntryChanges[K] } = {};
  if (set.length > 0) changes.set = Object.fromEntries(set);
  if (patch.length > 0) changes.patch = Object.fromEntries(patch);
  return changes;
}

/** The keys an object delta without `keys` produces: the base's, then the added ones. */
function impliedKeys(
  baseKeys: readonly string[],
  set: Readonly<Record<string, unknown>>,
): readonly string[] {
  const baseKeySet = new Set(baseKeys);
  const added = Object.keys(set).filter((key) => !baseKeySet.has(key));
  return added.length === 0 ? baseKeys : [...baseKeys, ...added];
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

/** Whether `value` is an object literal: its prototype is some realm's `Object.prototype`. */
function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  // Not `=== Object.prototype`: workflow bodies run in their own VM context.
  return prototype !== null && Object.getPrototypeOf(prototype) === null;
}

function deltaMismatch(expected: string): Error {
  return new Error(`Value delta does not match its base: expected ${expected}.`);
}
