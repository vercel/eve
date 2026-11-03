import type { ValidQueueName, World, WorkflowRun } from "#compiled/@workflow/world/index.js";
import type { LocalWorld } from "#compiled/@workflow/world-local/index.js";

/**
 * Queues a run the previous process left active, as world-local's own
 * startup recovery does, through the caller's `enqueue`.
 *
 * It first hands the run's steps that were running inline in the previous
 * process back to the queue, so they run again now instead of after the
 * inline-ownership lease (860s). That treats every step started before this
 * process loaded the local World as dead, so it is only safe while no other
 * live process uses the data directory.
 *
 * The message is marked `recovery` because the local queue is in memory: the
 * run's step messages and wait timers died with the previous process, and a
 * spec 9 run sends them again only for a recovery message. `runSpecVersion`
 * lets the queue serialize a spec 9 run's recovery behind its other
 * deliveries.
 */
export async function reenqueueRecoveredLocalRun(input: {
  readonly world: LocalWorld;
  readonly enqueue: World["queue"];
  readonly queueName: ValidQueueName;
  readonly run: Pick<WorkflowRun, "runId" | "specVersion">;
}): Promise<void> {
  const { run } = input;
  try {
    await input.world.releaseOrphanedSteps(run.runId);
  } catch (error) {
    // The run is still recoverable, just only once the lease ends.
    console.warn(`[eve] Failed to release orphaned steps of workflow run ${run.runId}:`, error);
  }
  await input.enqueue(input.queueName, {
    runId: run.runId,
    ...(typeof run.specVersion === "number" && { runSpecVersion: run.specVersion }),
    recovery: true,
  });
}
