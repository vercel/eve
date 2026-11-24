const PROCESS_APP = Symbol.for("eve.app");

export function resetTestRealm(): void {
  delete (globalThis as Record<symbol, unknown>)[PROCESS_APP];
}

resetTestRealm();
