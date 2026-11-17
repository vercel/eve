function singleton(name: string, version: number): Record<string, unknown> | undefined {
  return (globalThis as Record<symbol, unknown>)[Symbol.for(`${name}/v${version}`)] as
    | Record<string, unknown>
    | undefined;
}

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
  const fs = singleton("@workflow/world-local//fs", 1);
  clearCollections(fs?.createdFilesCache);
  clearCollections(fs?.createdDirectoriesCache);
  clearCollections(singleton("@workflow/world-local//hookIndexEnsureCache", 1)?.ensuredBasedirs);
  const port = singleton("@workflow/core//devServerPort", 1);
  if (port !== undefined) {
    port.cachedPort = undefined;
    port.inFlight = undefined;
  }
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
