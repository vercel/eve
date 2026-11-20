const EVE_RUNTIME = Symbol.for("eve.runtime");

export function resetTestRealm(): void {
  delete (globalThis as Record<symbol, unknown>)[EVE_RUNTIME];
}

resetTestRealm();
