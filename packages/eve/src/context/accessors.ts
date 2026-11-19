import { loadContext } from "#context/container.js";
import type { ContextKey } from "#context/key.js";

export type {
  Session,
  SessionAuth,
  SessionAuthContext,
  SessionParent,
  SessionPredecessor,
  SessionTurn,
} from "#context/keys.js";

export function getContext<T>(key: ContextKey<T>): T | undefined {
  return loadContext().get(key);
}

export function setContext<T>(
  key: ContextKey<T>,
  valueOrUpdater: T | ((current: T | undefined) => T),
): T {
  return loadContext().set(key, valueOrUpdater);
}

export function ensureContext<T>(key: ContextKey<T>, create: () => T): T {
  return loadContext().ensure(key, create);
}
