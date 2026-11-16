/**
 * Workflow keeps some state on `globalThis` for the life of a process (`globalSingleton`), and
 * holds it from module scope. A test file that shares its worker empties it before its World
 * opens, so the file starts as a new process would. The modules keep their references, so the
 * state is emptied in place and its shape is kept.
 */

/** One `globalSingleton` state, as `@workflow/*` keys it. */
function singleton(name: string, version: number): Record<string, unknown> | undefined {
  return (globalThis as Record<symbol, unknown>)[Symbol.for(`${name}/v${version}`)] as
    | Record<string, unknown>
    | undefined;
}

/** Empties a `Map` or `Set`, or the ones a state object holds one level down. */
function clearCollections(value: unknown): void {
  if (value instanceof Map || value instanceof Set) {
    value.clear();
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const nested of Object.values(value)) {
    if (nested instanceof Map || nested instanceof Set) nested.clear();
  }
}

// Warnings Workflow logs once per process, which a later file asserting on one would not see.
// `queueAuthRefusalLog` and `queueAuthSettingLogs` are not here: they hold log limiters that keep
// their state in closures, so they cannot be reset from outside.
const WARNED_ONCE = [
  "@workflow/core//crossDeploymentProbeMissWarning",
  "@workflow/core//envWarnings",
  "@workflow/core//eventLimitWarnings",
  "@workflow/core//latestNoOpWarning",
  "@workflow/core//traceModeWarnings",
  "@workflow/core//undeclaredQueueAuthModeWarning",
  "@workflow/world-local//buildTargetWarnings",
] as const;

export function resetWorkflowProcessCaches(): void {
  // The write path remembers the files and directories it created, and conflicts on a path it
  // remembers. The file's World clears its data directory, so those files are gone.
  const fs = singleton("@workflow/world-local//fs", 1);
  clearCollections(fs?.createdFilesCache);
  clearCollections(fs?.createdDirectoriesCache);
  // A finished hook-index backfill, remembered per data directory, which the file clears.
  clearCollections(singleton("@workflow/world-local//hookIndexEnsureCache", 1)?.ensuredBasedirs);
  // The port Workflow found this process listening on. The cross-deployment probe cache is a
  // `WeakMap` keyed by World, so a file's new World never sees another file's answers.
  const port = singleton("@workflow/core//devServerPort", 1);
  if (port !== undefined) {
    port.cachedPort = undefined;
    port.inFlight = undefined;
  }
  // A step still in flight when the previous file's World closed.
  clearCollections(singleton("@workflow/core//stepSingleFlight", 1));
  for (const name of WARNED_ONCE) {
    const warned = singleton(name, 1);
    if (warned === undefined) continue;
    clearCollections(warned);
    for (const [field, value] of Object.entries(warned)) {
      if (typeof value === "boolean") warned[field] = false;
    }
  }
}
