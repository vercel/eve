import { getRun, getWorld } from "#internal/workflow/runtime.js";

const caches = new WeakMap<object, Map<string, ReturnType<typeof getRun>>>();
const MAX_RUNS = 256;

/** Reuse the SDK's per-run key cache without caching stream contents or run status. */
export async function getStreamRun(runId: string): Promise<ReturnType<typeof getRun>> {
  const world = await getWorld();
  let cache = caches.get(world);
  if (cache === undefined) {
    cache = new Map();
    caches.set(world, cache);
  }
  let run = cache.get(runId);
  if (run === undefined) {
    run = getRun(runId);
    cache.set(runId, run);
    if (cache.size > MAX_RUNS) cache.delete(cache.keys().next().value!);
  }
  return run;
}

export async function forgetStreamRun(runId: string): Promise<void> {
  caches.get(await getWorld())?.delete(runId);
}
