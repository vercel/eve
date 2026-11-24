import { type ContextAccessor, type ContextKey, resolveKey } from "#context/key.js";
import { LocalDevRequestKey, type LocalDevRequestProvenance } from "#context/keys.js";
import { createScopeStorage, type ScopeStorage } from "#context/scope-storage.js";

const EVE_CONTEXT_STORAGE_KEY = Symbol.for("eve.context-storage");

export interface AlsContext extends ContextAccessor {
  readonly localDevRequest?: LocalDevRequestProvenance;
  delete<T>(key: ContextKey<T>): boolean;
  entries(): Iterable<readonly [ContextKey<unknown>, unknown]>;
  setVirtualContext<T>(key: ContextKey<T>, value: T): void;
}

export class ContextContainer implements AlsContext {
  private readonly _durableValues = new Map<string, unknown>();
  private readonly _virtualValues = new Map<string, unknown>();

  constructor(input?: { readonly localDevRequest?: LocalDevRequestProvenance }) {
    const localDevRequest =
      input !== undefined && Object.hasOwn(input, "localDevRequest")
        ? input.localDevRequest
        : contextStorage.getStore()?.localDevRequest;
    if (localDevRequest !== undefined) {
      this._durableValues.set(LocalDevRequestKey.name, localDevRequest);
    }
  }

  get localDevRequest(): LocalDevRequestProvenance | undefined {
    return this.get(LocalDevRequestKey);
  }

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

  delete<T>(key: ContextKey<T>): boolean {
    const deletedDurable = this._durableValues.delete(key.name);
    const deletedVirtual = this._virtualValues.delete(key.name);
    return deletedDurable || deletedVirtual;
  }

  clearVirtualContext(): void {
    this._virtualValues.clear();
  }

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

interface ContextScope {
  readonly context: AlsContext | undefined;
  readonly values?: ReadonlyMap<symbol, unknown>;
}

type AlsContextStorageGlobal = typeof globalThis & {
  [EVE_CONTEXT_STORAGE_KEY]?: ScopeStorage<ContextScope>;
};

const globalContextStorage = globalThis as AlsContextStorageGlobal;

if (globalContextStorage[EVE_CONTEXT_STORAGE_KEY] === undefined) {
  globalContextStorage[EVE_CONTEXT_STORAGE_KEY] = createScopeStorage<ContextScope>("context");
}

const storage = globalContextStorage[EVE_CONTEXT_STORAGE_KEY];
export const contextStorage = {
  kind: storage.kind,
  getStore: (): AlsContext | undefined => storage.getStore()?.context,
  run: <T>(context: AlsContext, fn: () => T): T => storage.run({ context }, fn),
};

export function contextScopeValue<T>(key: symbol): T | undefined {
  return storage.getStore()?.values?.get(key) as T | undefined;
}

export function withContextScopeValue<T>(key: symbol, value: unknown, fn: () => T): T {
  const parent = storage.getStore();
  const values = new Map(parent?.values);
  values.set(key, value);
  return storage.run({ context: parent?.context, values }, fn);
}

export function loadContext(): AlsContext {
  const ctx = contextStorage.getStore();
  if (ctx === undefined) {
    throw new Error(
      "No active eve context. " +
        "Call this function only from code eve runs, such as tools, hooks, channel handlers, and model callbacks.",
    );
  }
  return ctx;
}
