import type { QueuePayload, WorkflowRun } from "#compiled/@workflow/world/index.js";
import type { LocalWorld } from "#compiled/@workflow/world-local/index.js";
import { mapWithConcurrency } from "#shared/map-with-concurrency.js";

const RELEASE_CONCURRENCY = 8;

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

export function localRecoveryMessage(
  run: Pick<WorkflowRun, "runId" | "specVersion">,
): QueuePayload {
  return {
    runId: run.runId,
    ...(typeof run.specVersion === "number" && { runSpecVersion: run.specVersion }),
    recovery: true,
  };
}
