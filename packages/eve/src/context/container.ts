import { AsyncLocalStorage } from "node:async_hooks";

import { type ContextAccessor, type ContextKey, resolveKey } from "#context/key.js";

const EVE_CONTEXT_STORAGE_KEY = Symbol.for("eve.context-storage");

/**
 * Keyed value container that backs one eve execution scope.
 *
 * Durable values are serialized across workflow steps and turns. Virtual
 * values are rebuilt each step by context providers and are never
 * serialized.
 *
 * Extends {@link ContextAccessor} with the `entries()` iterator used by
 * the serialization layer.
 */
export interface AlsContext extends ContextAccessor {
  /**
   * Iterates all durable key/value pairs currently stored in the context.
   * Used by the serialization layer to persist context at step boundaries.
   */
  entries(): Iterable<readonly [ContextKey<unknown>, unknown]>;
  /** Stores a step-local value that shadows the durable value and is never serialized. */
  setVirtualContext<T>(key: ContextKey<T>, value: T): void;
}

/**
 * Default mutable implementation of {@link AlsContext}.
 */
export class ContextContainer implements AlsContext {
  private readonly _durableValues = new Map<string, unknown>();
  private readonly _virtualValues = new Map<string, unknown>();

  get<T>(key: ContextKey<T>): T | undefined {
    if (this._virtualValues.has(key.name)) {
      return this._virtualValues.get(key.name) as T;
    }
    return this._durableValues.get(key.name) as T | undefined;
  }

  require<T>(key: ContextKey<T>): T {
    if (!this.has(key)) {
      throw new Error(`Context key "${key.name}" is not set.`);
    }
    return this.get(key) as T;
  }

  has<T>(key: ContextKey<T>): boolean {
    return this._virtualValues.has(key.name) || this._durableValues.has(key.name);
  }

  set<T>(key: ContextKey<T>, valueOrUpdater: T | ((current: T | undefined) => T)): T {
    const value =
      typeof valueOrUpdater === "function"
        ? (valueOrUpdater as (current: T | undefined) => T)(this.get(key))
        : valueOrUpdater;
    this._durableValues.set(key.name, value);
    return value;
  }

  ensure<T>(key: ContextKey<T>, create: () => T): T {
    if (this.has(key)) {
      return this.require(key);
    }
    return this.set(key, create());
  }

  /**
   * Clears all step-local provider values from the context.
   *
   * The runtime calls this before rebuilding context providers for a new
   * step.
   */
  clearVirtualContext(): void {
    this._virtualValues.clear();
  }

  /**
   * Stores a step-local provider value for one key.
   *
   * Virtual values shadow durable values for the lifetime of the current
   * step and are excluded from serialization.
   */
  setVirtualContext<T>(key: ContextKey<T>, value: T): void {
    this._virtualValues.set(key.name, value);
  }

  *entries(): Generator<readonly [ContextKey<unknown>, unknown]> {
    for (const [name, value] of this._durableValues) {
      const key = resolveKey(name);
      if (key !== undefined) {
        yield [key, value] as const;
      }
    }
  }
}

type AlsContextStorageGlobal = typeof globalThis & {
  [EVE_CONTEXT_STORAGE_KEY]?: AsyncLocalStorage<AlsContext>;
};

const globalContextStorage = globalThis as AlsContextStorageGlobal;

if (globalContextStorage[EVE_CONTEXT_STORAGE_KEY] === undefined) {
  globalContextStorage[EVE_CONTEXT_STORAGE_KEY] = new AsyncLocalStorage<AlsContext>();
}

/**
 * Process-wide AsyncLocalStorage used by every eve module copy in the current
 * runtime.
 *
 * Nitro step bundles can inline parts of eve while authored modules still
 * import `eve/*` from disk. Backing the storage with a global
 * symbol keeps those copies on the same ALS instance so authored tools,
 * model callbacks, and step code observe one unified eve context.
 */
export const contextStorage = globalContextStorage[EVE_CONTEXT_STORAGE_KEY];

/**
 * Returns the active context, throwing when called outside a managed scope.
 */
export function loadContext(): AlsContext {
  const ctx = contextStorage.getStore();
  if (ctx === undefined) {
    throw new Error(
      "No active eve context. " +
        "Call this function only from authored runtime code such as tools, steps, and model callbacks.",
    );
  }
  return ctx;
}
