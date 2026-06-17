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

const RESERVED_STATE_NAME_PREFIX = "eve.";

/**
 * Creates a typed, named state slot backed by a durable `ContextKey`.
 * `initial()` produces the value on first access within a context.
 *
 * The name must not start with the reserved `"eve."` prefix (reserved
 * for framework context keys); doing so throws.
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
  if (name.startsWith(RESERVED_STATE_NAME_PREFIX)) {
    throw new Error(
      `defineState() name "${name}" uses the reserved "${RESERVED_STATE_NAME_PREFIX}" prefix, which eve reserves for its own framework context keys (e.g. "eve.channel", "eve.bundle"). Colliding with one silently corrupts context serialization. Use your own namespace, e.g. "my-agent.${name.slice(RESERVED_STATE_NAME_PREFIX.length)}".`,
    );
  }

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
