/** Internal value patches over serialized session data. Opaque values stay on Workflow's codec path. */
export type ValueDelta =
  | { readonly kind: "keep" }
  | { readonly kind: "replace"; readonly value: unknown }
  | {
      readonly kind: "object";
      readonly remove: readonly string[];
      readonly set: Readonly<Record<string, ValueDelta>>;
    }
  | {
      readonly kind: "array";
      readonly beforeLength: number;
      readonly length: number;
      readonly remove: readonly string[];
      readonly set: Readonly<Record<string, ValueDelta>>;
    };

const opaque = Symbol("opaque captured value");
const keep = { kind: "keep" } as const;

/**
 * Capture before executing authored code, which may mutate nested state in place.
 * Aliased subtrees travel together; rich values retain full replacement to preserve codec semantics.
 */
export function captureValue(value: unknown): unknown {
  const seen = new Map<object, readonly string[]>();
  const atomic = new Set<string>();
  function inspect(current: unknown, path: readonly string[]): void {
    if (typeof current === "function" || typeof current === "symbol") {
      atomic.add("[]");
      return;
    }
    if (current === null || typeof current !== "object") return;
    const previous = seen.get(current);
    if (previous !== undefined) {
      let common = 0;
      while (common < previous.length && previous[common] === path[common]) common++;
      atomic.add(JSON.stringify(path.slice(0, common)));
      return;
    }
    seen.set(current, path);
    if (
      (!isRecord(current) && !Array.isArray(current)) ||
      Object.getOwnPropertySymbols(current).length > 0
    ) {
      atomic.add("[]");
      return;
    }
    for (const key of Object.keys(current)) inspect(Reflect.get(current, key), [...path, key]);
  }
  inspect(value, []);
  function capture(current: unknown, path: readonly string[]): unknown {
    if (atomic.has(JSON.stringify(path))) return opaque;
    if (current === null || typeof current !== "object") return current;
    const copy: Record<string, unknown> | unknown[] = Array.isArray(current)
      ? []
      : Object.create(Object.getPrototypeOf(current));
    if (Array.isArray(copy)) copy.length = (current as unknown[]).length;
    for (const key of Object.keys(current)) {
      define(copy, key, capture(Reflect.get(current, key), [...path, key]));
    }
    return copy;
  }
  return capture(value, []);
}

export function createValueDelta(before: unknown, after: unknown): ValueDelta {
  return diff(before, after, captureValue(after));
}

function diff(before: unknown, after: unknown, capturedAfter: unknown): ValueDelta {
  // Replace the common ancestor of aliases together, retaining graph identity without repeating history.
  if (before === opaque || capturedAfter === opaque) return { kind: "replace", value: after };
  if (Object.is(before, after)) return keep;
  const arrays = Array.isArray(before) && Array.isArray(after);
  if (arrays || (isRecord(before) && isRecord(after))) {
    if (Object.getPrototypeOf(before) !== Object.getPrototypeOf(after)) {
      return { kind: "replace", value: after };
    }
    const previous = before as Record<string, unknown>;
    const next = after as Record<string, unknown>;
    const remove = Object.keys(previous).filter((key) => !Object.hasOwn(next, key));
    const set: Record<string, ValueDelta> = {};
    for (const key of Object.keys(next)) {
      const change = Object.hasOwn(previous, key)
        ? diff(previous[key], next[key], Reflect.get(capturedAfter as object, key))
        : { kind: "replace" as const, value: next[key] };
      if (change.kind !== "keep") define(set, key, change);
    }
    if (
      remove.length === 0 &&
      Object.keys(set).length === 0 &&
      (!arrays || before.length === after.length)
    )
      return keep;
    return arrays
      ? { kind: "array", beforeLength: before.length, length: after.length, remove, set }
      : { kind: "object", remove, set };
  }
  return { kind: "replace", value: after };
}

/** Copy-on-write keeps the pre-step checkpoint available for cancellation and background work. */
export function applyValueDelta(before: unknown, delta: ValueDelta): unknown {
  if (delta.kind === "keep") return before;
  if (delta.kind === "replace") return delta.value;
  if (
    (delta.kind === "array" && (!Array.isArray(before) || before.length !== delta.beforeLength)) ||
    (delta.kind === "object" && !isRecord(before))
  )
    throw new Error(
      `Session state delta does not match its checkpoint (${delta.kind}${delta.kind === "array" ? `: expected length ${delta.beforeLength}, received ${Array.isArray(before) ? before.length : "non-array"}` : ""}).`,
    );
  const result =
    delta.kind === "array"
      ? (before as unknown[]).slice()
      : Object.create(Object.getPrototypeOf(before));
  for (const key of Object.keys(before as object))
    define(result, key, Reflect.get(before as object, key));
  for (const key of delta.remove) {
    if (!Object.hasOwn(before as object, key)) {
      throw new Error("Session state delta removes a missing checkpoint field.");
    }
    Reflect.deleteProperty(result, key);
  }
  for (const [key, change] of Object.entries(delta.set)) {
    define(
      result,
      key,
      applyValueDelta(
        Object.hasOwn(before as object, key) ? Reflect.get(before as object, key) : undefined,
        change,
      ),
    );
  }
  if (delta.kind === "array") result.length = delta.length;
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  // Warm Workflow execution can hand the VM records created in the host realm.
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}
