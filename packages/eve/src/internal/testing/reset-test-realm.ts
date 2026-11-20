const REALM_KEYS = [Symbol.for("eve.hosts"), Symbol.for("eve.runtime")] as const;

export function resetTestRealm(): void {
  for (const key of REALM_KEYS) {
    delete (globalThis as Record<symbol, unknown>)[key];
  }
}

resetTestRealm();
