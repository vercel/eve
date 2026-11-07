import { asyncLocalStorage } from "#platform/async-storage.js";

/**
 * Async-scoped storage: Node's `AsyncLocalStorage` where the runtime has it, otherwise one current
 * scope per storage (browsers, Web Workers).
 *
 * Without AsyncLocalStorage, `run` sets the scope, runs the callback, and restores the previous
 * scope when the callback's promise settles, not when it returns: eve reads context after awaits
 * everywhere. That's sound only while scopes nest in time, every scope opened inside another
 * settling first and no unrelated branch running meanwhile. Tool calls one at a time and one
 * session per realm give eve that (`harness/tool-concurrency.ts`). A scope that exits while another
 * is current breaks it for good: from then on every read throws (`ScopeOrderError`) rather than
 * seeing the wrong context.
 */
export interface ScopeStorage<T> {
  /** Which storage this is; tool calls run in parallel only under AsyncLocalStorage. */
  readonly kind: ScopeStorageKind;
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
}

/** Which storage backs eve's scopes in this realm. */
export type ScopeStorageKind = "async-local-storage" | "settling";

/** An AsyncLocalStorage class, as `#platform/async-storage` provides one. */
export type AsyncScopeStorageClass = new <T>() => {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
};

/** A scope that exited while another was current. */
export class ScopeOrderError extends Error {
  override readonly name = "ScopeOrderError";
}

/** The scope storage this platform gives eve's `label` scopes. */
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

/** The storage without AsyncLocalStorage (see {@link ScopeStorage}); exported for tests. */
export function settlingScopeStorage<T>(label: string): ScopeStorage<T> {
  let current: Frame<T> | undefined;
  // Set by the first scope to exit out of order. Which scope is current is unknowable after that.
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
      // The scope ends when the callback's promise settles. This runs before the caller's own
      // continuation, which awaits the same promise and is attached after it.
      result.then(
        () => exit(frame, previous),
        () => exit(frame, previous),
      );
      return result;
    },
  };
}
