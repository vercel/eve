import { ContextKey } from "#context/key.js";
import { loadContext } from "#context/container.js";

/**
 * Typed handle returned by {@link defineState}. Reads and updates a
 * named context slot.
 *
 * All operations require an active eve context (ALS scope) and throw
 * when called outside one.
 */
export interface StateHandle<T> {
  /** Read the current value. Returns `initial()` on first access within a context. */
  get(): T;
  /** Update the value with a function that receives the current value. */
  update(fn: (current: T) => T): void;
}

const RESERVED_STATE_NAME_PREFIXES = ["eve.", "eve:mount."] as const;

/**
 * Creates a typed, named state slot backed by a durable `ContextKey`.
 * `initial()` produces the value on first access within a context.
 *
 * Names starting with `"eve."` or `"eve:mount."` are reserved for framework
 * context keys; using either prefix throws.
 *
 * All operations require an active eve context. Calling `get()` or
 * `update()` outside of tools, hooks, or other framework-managed code
 * throws.
 *
 * State is durable: values survive across workflow step boundaries.
 * To reset per-turn, call `update(() => freshValue)` in a lifecycle
 * hook.
 *
 * ```ts
 * const budget = defineState("my-agent.budget", () => ({ count: 0, cap: 25 }));
 *
 * // In a tool or hook:
 * budget.update((s) => ({ ...s, count: s.count + 1 }));
 * const current = budget.get();
 * ```
 */
export function defineState<T>(name: string, initial: () => T): StateHandle<T> {
  const reserved = RESERVED_STATE_NAME_PREFIXES.find((prefix) => name.startsWith(prefix));
  if (reserved !== undefined) {
    throw new Error(
      `defineState() name "${name}" uses the reserved "${reserved}" prefix. Use an application-owned namespace instead.`,
    );
  }
  return createStateHandle(name, initial);
}

/** Internal registration of generated, mount-owned keys. */
export function defineMountedState<T>(
  mountId: string,
  name: string,
  initial: () => T,
): StateHandle<T> {
  return createStateHandle(
    `eve:mount.v1:${encodeURIComponent(mountId)}:${encodeURIComponent(name)}`,
    initial,
  );
}

function createStateHandle<T>(name: string, initial: () => T): StateHandle<T> {
  const key = new ContextKey<T>(name);

  return {
    get(): T {
      return loadContext().ensure(key, initial);
    },

    update(fn: (current: T) => T): void {
      const ctx = loadContext();
      const current = ctx.ensure(key, initial);
      ctx.set(key, fn(current));
    },
  };
}
