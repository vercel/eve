import type { World } from "#compiled/@workflow/world/index.js";
import { cancelRun } from "#internal/workflow/runtime.js";

export async function cancelExpiredDevelopmentRun(world: World, runId: string): Promise<void> {
  const run = await world.runs.get(runId, { resolveData: "none" });
  if (run.status !== "pending" && run.status !== "running") return;
  try {
    await cancelRun(world, runId, {
      cancelReason: "Development runtime snapshot is no longer available",
    });
  } catch (error) {
    // A delivery can finish between the scan and cancellation.
    const current = await world.runs.get(runId, { resolveData: "none" });
    if (current.status === "pending" || current.status === "running") throw error;
  }
}
