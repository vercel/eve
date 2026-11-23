import { asyncLocalStorage } from "#runtime-env/async-storage.js";

export interface ScopeStorage<T> {
  readonly kind: ScopeStorageKind;
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
}

export type ScopeStorageKind = "async-local-storage" | "settling";

export type AsyncScopeStorageClass = new <T>() => {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
};

export class ScopeOrderError extends Error {
  override readonly name = "ScopeOrderError";
}

export function createScopeStorage<T>(label: string): ScopeStorage<T> {
  if (asyncLocalStorage === undefined) return settlingScopeStorage<T>(label);
  const storage = new asyncLocalStorage<T>();
  return {
    kind: "async-local-storage",
    getStore: () => storage.getStore(),
    run: (store, fn) => storage.run(store, fn),
  };
}

interface Frame<T> {
  readonly store: T;
}

export function settlingScopeStorage<T>(label: string): ScopeStorage<T> {
  let current: Frame<T> | undefined;
  let broken: ScopeOrderError | undefined;
  const exit = (frame: Frame<T>, previous: Frame<T> | undefined): void => {
    if (current !== frame) {
      broken ??= new ScopeOrderError(
        `An eve ${label} scope exited while another was current. Without AsyncLocalStorage, eve keeps one current scope, so scopes must settle in the order they opened: run tool calls one at a time and one session per realm.`,
      );
    }
    current = previous;
  };
  return {
    kind: "settling",
    getStore() {
      if (broken !== undefined) throw broken;
      return current?.store;
    },
    run(store, fn) {
      const previous = current;
      const frame: Frame<T> = { store };
      current = frame;
      let result;
      try {
        result = fn();
      } catch (error) {
        exit(frame, previous);
        throw error;
      }
      if (!(result instanceof Promise)) {
        exit(frame, previous);
        return result;
      }
      result.then(
        () => exit(frame, previous),
        () => exit(frame, previous),
      );
      return result;
    },
  };
}
