export type ValueDelta =
  | { readonly kind: "value"; readonly value: unknown }
  | (EntryChanges & {
      readonly kind: "object";
      readonly keys?: readonly string[];
    })
  | (EntryChanges & { readonly kind: "array"; readonly length: number });

interface EntryChanges {
  readonly patch?: Readonly<Record<string, ValueDelta>>;
  readonly set?: Readonly<Record<string, unknown>>;
}

type PlainObject = Readonly<Record<string, unknown>>;

export function snapshotValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry: unknown) => snapshotValue(entry)) as T;
  if (!isPlainObject(value)) return value;
  return objectLike(
    value,
    Object.keys(value).map((key) => [key, snapshotValue(value[key])]),
  ) as T;
}

export function diffValue(base: unknown, next: unknown): ValueDelta | undefined {
  if (Object.is(base, next)) return undefined;
  if (Array.isArray(base) && Array.isArray(next)) return diffArray(base, next);
  if (isPlainObject(base) && isPlainObject(next) && isDictionary(base) === isDictionary(next)) {
    return diffObject(base, next);
  }
  return { kind: "value", value: next };
}

export function applyValueDelta<T>(base: T, delta: ValueDelta | undefined): T {
  if (delta === undefined) return base;
  switch (delta.kind) {
    case "value":
      return delta.value as T;
    case "array": {
      if (!Array.isArray(base)) throw deltaMismatch("an array");
      const next = base.slice(0, delta.length);
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
      return objectLike(
        base,
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

function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

function isDictionary(value: PlainObject): boolean {
  return Object.getPrototypeOf(value) === null;
}

function objectLike(
  like: PlainObject,
  entries: readonly (readonly [string, unknown])[],
): PlainObject {
  const object = Object.fromEntries(entries);
  return isDictionary(like) ? Object.assign(Object.create(null) as PlainObject, object) : object;
}

function deltaMismatch(expected: string): Error {
  return new Error(`Value delta does not match its base: expected ${expected}.`);
}
