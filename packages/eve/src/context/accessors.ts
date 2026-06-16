import { loadContext } from "#context/container.js";
import type { ContextKey } from "#context/key.js";

// Re-export so the public barrel can pull everything from one place.
export type {
  Session,
  SessionAuth,
  SessionAuthContext,
  SessionParent,
  SessionTurn,
} from "#context/keys.js";

/**
 * Returns the current value of a context key, or `undefined` when unset.
 *
 * @throws When called outside of a managed step execution.
 */
export function getContext<T>(key: ContextKey<T>): T | undefined {
  return loadContext().get(key);
}

/**
 * Returns the current value of a context key, throwing when unset.
 *
 * @throws When the key is not set or when called outside of a managed
 *   step execution.
 */
export function requireContext<T>(key: ContextKey<T>): T {
  return loadContext().require(key);
}

/**
 * Returns whether the key is currently set in the active context.
 *
 * @throws When called outside of a managed step execution.
 */
export function hasContext<T>(key: ContextKey<T>): boolean {
  return loadContext().has(key);
}

/**
 * Sets the durable value of a context key in the active context.
 *
 * Accepts either a direct value or an updater function that receives the
 * current value (or `undefined` if unset) and returns the next value.
 *
 * The new durable value is serialized at the end of the step and survives
 * future workflow steps and turns.
 *
 * @throws When called outside of a managed step execution.
 */
export function setContext<T>(
  key: ContextKey<T>,
  valueOrUpdater: T | ((current: T | undefined) => T),
): T {
  return loadContext().set(key, valueOrUpdater);
}

/**
 * Returns the current value of a context key or initializes and stores a
 * durable value when the key is unset.
 *
 * @throws When called outside of a managed step execution.
 */
export function ensureContext<T>(key: ContextKey<T>, create: () => T): T {
  return loadContext().ensure(key, create);
}
