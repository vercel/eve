import { contextStorage, loadContext } from "#context/container.js";
import type { ContextKey } from "#context/key.js";
import { AuthKey, type SessionAuthContext } from "#context/keys.js";

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

/**
 * The caller of the session code is running for, or `undefined` outside eve-run code. Unlike `getContext`, it never throws,
 * so a library that serves several callers from one process can read who the current one is without being handed the context.
 */
export function getCurrentAuth(): SessionAuthContext | null | undefined {
  return contextStorage.getStore()?.get(AuthKey);
}
