import type { World } from "#compiled/@workflow/world/index.js";
import { EVE_VERSION_ATTRIBUTE } from "#execution/eve-workflow-attributes.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";

export type OwnerRun = Awaited<ReturnType<World["runs"]["get"]>>;

const RUNNABLE_OWNER_CACHE_LIMIT = 10_000;

const runnableOwnerRunIds = new Set<string>();

export function routesToOwnerDeployment(world: Pick<World, "capabilities">): boolean {
  return world.capabilities?.deploymentAffinity === true;
}

function isRunnableOwnerRun(run: Pick<OwnerRun, "attributes">): boolean {
  return run.attributes[EVE_VERSION_ATTRIBUTE] === resolveInstalledPackageInfo().version;
}

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
