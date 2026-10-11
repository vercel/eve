import type { SessionAuthContext } from "#channel/types.js";
import { type AlsContext, contextStorage } from "#context/container.js";
import type { ContextKey } from "#context/key.js";
import { AuthKey, type Session, SessionKey } from "#context/keys.js";

/**
 * Runs `fn` with `caller` as the session's current caller. Writes still reach
 * the outer context; only reads of the caller change, so work running beside
 * `fn` in the same step keeps the outer caller.
 */
export function runAsCaller<T>(caller: SessionAuthContext, fn: () => T): T {
  const outer = contextStorage.getStore();
  if (outer === undefined) return fn();
  return contextStorage.run(new CallerScope(outer, caller), fn);
}

class CallerScope implements AlsContext {
  readonly #caller: SessionAuthContext;
  readonly #outer: AlsContext;

  constructor(outer: AlsContext, caller: SessionAuthContext) {
    this.#outer = outer;
    this.#caller = caller;
  }

  get localDevRequest() {
    return this.#outer.localDevRequest;
  }

  get<T>(key: ContextKey<T>): T | undefined {
    if (key.name === AuthKey.name) return this.#caller as T;
    if (key.name === SessionKey.name) {
      const session = this.#outer.get(SessionKey);
      if (session === undefined) return undefined;
      const scoped: Session = { ...session, auth: { ...session.auth, current: this.#caller } };
      return scoped as T;
    }
    return this.#outer.get(key);
  }

  require<T>(key: ContextKey<T>): T {
    if (!this.has(key)) throw new Error(`Context key "${key.name}" is not set.`);
    return this.get(key) as T;
  }

  has<T>(key: ContextKey<T>): boolean {
    return key.name === AuthKey.name || this.#outer.has(key);
  }

  set<T>(key: ContextKey<T>, valueOrUpdater: T | ((current: T | undefined) => T)): T {
    return this.#outer.set(key, valueOrUpdater);
  }

  ensure<T>(key: ContextKey<T>, create: () => T): T {
    return this.#outer.ensure(key, create);
  }

  delete<T>(key: ContextKey<T>): boolean {
    return this.#outer.delete(key);
  }

  entries(): Iterable<readonly [ContextKey<unknown>, unknown]> {
    return this.#outer.entries();
  }

  setVirtualContext<T>(key: ContextKey<T>, value: T): void {
    this.#outer.setVirtualContext(key, value);
  }
}
