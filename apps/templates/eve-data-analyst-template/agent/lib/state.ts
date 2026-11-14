import { defineState as eveState } from "eve/context";
import type { StateHandle } from "eve/context";

/** The state interface used by application adapters and faithful test providers. */
export const stateProvider = { create: eveState };

/**
 * Resolve state through the active provider while keeping eve's durable slot name.
 * @typeParam T - Persisted value owned by this durable slot.
 * @param name - Durable application-owned slot name.
 * @param initial - Initial value when the session has no checkpoint for this slot.
 * @returns A handle that resolves its provider when read or updated.
 */
export const defineState = <T>(
  name: string,
  initial: () => T
): StateHandle<T> => {
  // Register the native slot at module load so resumed checkpoints know its key.
  const native = eveState(name, initial);
  const current = () =>
    stateProvider.create === eveState
      ? native
      : stateProvider.create(name, initial);
  return {
    get: () => current().get(),
    update: (change) => current().update(change),
  };
};
