import type { World } from "#compiled/@workflow/world/index.js";
import { EVE_VERSION_ATTRIBUTE } from "#execution/eve-workflow-attributes.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";

export type OwnerRun = Awaited<ReturnType<World["runs"]["get"]>>;

/** Bounds the process-wide set; a cleared entry only costs one more run read. */
const RUNNABLE_OWNER_CACHE_LIMIT = 10_000;

/**
 * Owner runs this process has seen record the running eve version. A run's
 * version never changes once it starts, so a positive answer stays true for
 * the life of the process; retired owners are never cached.
 */
const runnableOwnerRunIds = new Set<string>();

/**
 * Whether the World replays every run on the deployment that started it
 * (Vercel). There, an owner from another eve version is the normal handoff
 * case, not a stranded one.
 */
export function routesToOwnerDeployment(world: Pick<World, "capabilities">): boolean {
  return world.capabilities?.deploymentAffinity === true;
}

/**
 * Whether this build can replay the owner run. On a World that does not route
 * each run to its own deployment, only one build serves it, so an owner that
 * records another eve version, or none, is retired: nothing can execute it again.
 */
function isRunnableOwnerRun(run: Pick<OwnerRun, "attributes">): boolean {
  return run.attributes[EVE_VERSION_ATTRIBUTE] === resolveInstalledPackageInfo().version;
}

/**
 * The owner run when it is retired, or `undefined` when this build can run it.
 * Reads the run only when it is not already known to be runnable.
 */
export async function findRetiredOwnerRun(
  world: Pick<World, "runs">,
  runId: string,
): Promise<OwnerRun | undefined> {
  if (runnableOwnerRunIds.has(runId)) return undefined;
  const run = await world.runs.get(runId, { resolveData: "none" });
  if (!isRunnableOwnerRun(run)) return run;
  if (runnableOwnerRunIds.size >= RUNNABLE_OWNER_CACHE_LIMIT) runnableOwnerRunIds.clear();
  runnableOwnerRunIds.add(runId);
  return undefined;
}
