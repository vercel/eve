import type { QueuePayload, WorkflowRun } from "#compiled/@workflow/world/index.js";
import type { LocalWorld } from "#compiled/@workflow/world-local/index.js";
import { mapWithConcurrency } from "#shared/map-with-concurrency.js";

/** How many runs startup recovery releases at once, as world-local's own recovery does. */
const RELEASE_CONCURRENCY = 8;

/**
 * Hands the steps that were running inline in the previous process back to
 * the queue, so recovery runs them again now instead of after the
 * inline-ownership lease (860s). Call it before re-enqueueing the runs.
 *
 * It treats every step started before this process loaded the local World as
 * dead, so it is only safe while no other live process uses the data
 * directory. A failed release only delays its run until the lease ends, so it
 * is logged and never stops recovery.
 */
export async function releaseOrphanedLocalSteps(
  world: LocalWorld,
  runIds: readonly string[],
): Promise<void> {
  await mapWithConcurrency(runIds, RELEASE_CONCURRENCY, async (runId) => {
    try {
      await world.releaseOrphanedSteps(runId);
    } catch (error) {
      console.warn(`[eve] Failed to release orphaned steps of workflow run ${runId}:`, error);
    }
  });
}

/**
 * The message that re-enqueues a run the previous process left active, as
 * world-local's own startup recovery sends it.
 *
 * `recovery` is set because the local queue is in memory: the run's step
 * messages and wait timers died with the previous process, and a spec 9 run
 * sends them again only for a recovery message. `runSpecVersion` lets the
 * queue serialize a spec 9 run's recovery behind its other deliveries.
 */
export function localRecoveryMessage(
  run: Pick<WorkflowRun, "runId" | "specVersion">,
): QueuePayload {
  return {
    runId: run.runId,
    ...(typeof run.specVersion === "number" && { runSpecVersion: run.specVersion }),
    recovery: true,
  };
}
