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
