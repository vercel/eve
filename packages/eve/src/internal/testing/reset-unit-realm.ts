/**
 * Clears the registries eve keeps on `globalThis`, so a unit test file starts in
 * an empty realm.
 *
 * These registries are process-wide on purpose: Workflow's local world and step
 * bundles load their own copies of eve's modules, and every copy must see the
 * same hosts. They also outlive the module reset between test files, so without
 * this a file that installs a durable host decides what the next file in the
 * worker sees, and `installDurableHost` refuses a second, different host.
 */

const REALM_KEYS = [
  // `#execution/hosts.js`
  Symbol.for("eve.hosts"),
  // `#instrumentation/runtime-global.js`
  Symbol.for("eve.instrumentation-runtime"),
] as const;

export function resetUnitRealm(): void {
  for (const key of REALM_KEYS) {
    delete (globalThis as Record<symbol, unknown>)[key];
  }
}

// Setup files load for every test file, before that file's imports.
resetUnitRealm();
