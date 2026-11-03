import type { LocalWorld } from "#compiled/@workflow/world-local/index.js";

/**
 * Lets a recovered run's next delivery dispatch at once, the step that its
 * previous process was running inline and died in, instead of waiting out the
 * inline-ownership lease. world-local does this in its own startup recovery,
 * which eve turns off (`recoverActiveRuns: false`) to recover through its own
 * queue, so eve's recovery loops call this before each run is re-enqueued.
 *
 * Under the same contract as world-local's recovery: only at startup, while no
 * other live process or worker thread runs workflows on this data directory.
 * A no-op on a world-local without `releaseOrphanedSteps` (before 5.2.0). A
 * failed release is logged and the run is still re-enqueued: it recovers,
 * just only once the lease expires.
 */
export async function releaseOrphanedLocalSteps(
  world: Pick<LocalWorld, "releaseOrphanedSteps">,
  runId: string,
): Promise<void> {
  if (world.releaseOrphanedSteps === undefined) return;
  try {
    await world.releaseOrphanedSteps(runId);
  } catch (error) {
    console.warn(`[eve] Failed to release orphaned steps of workflow run ${runId}:`, error);
  }
}
