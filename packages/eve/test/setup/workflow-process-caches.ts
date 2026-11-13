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

function clearCollections(value: unknown): void {
  if (value instanceof Map || value instanceof Set) value.clear();
}

// Warnings Workflow logs once per process, which a later file asserting on one would not see.
const WARNED_ONCE = [
  "@workflow/core//crossDeploymentProbeMissWarning",
  "@workflow/core//envWarnings",
  "@workflow/core//eventLimitWarnings",
  "@workflow/core//latestNoOpWarning",
  "@workflow/core//queueAuthRefusalLog",
  "@workflow/core//queueAuthSettingLogs",
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
  // The port Workflow found this process listening on, and a probe of the deployment it answers.
  const port = singleton("@workflow/core//devServerPort", 1);
  if (port !== undefined) {
    port.cachedPort = undefined;
    port.inFlight = undefined;
  }
  clearCollections(singleton("@workflow/core//crossDeploymentProbeCache", 1));
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
