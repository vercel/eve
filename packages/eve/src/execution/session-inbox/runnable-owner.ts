import type { World } from "#compiled/@workflow/world/index.js";
import {
  EVE_DEPLOYMENT_URL_ATTRIBUTE,
  EVE_VERSION_ATTRIBUTE,
} from "#execution/eve-workflow-attributes.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { EVE_HEALTH_ROUTE_PATH } from "#protocol/routes.js";

export type OwnerRun = Awaited<ReturnType<World["runs"]["get"]>>;

const OWNER_CACHE_LIMIT = 10_000;
const OWNER_CACHE_TTL_MS = 30_000;
const DEPLOYMENT_PROBE_TIMEOUT_MS = 3_000;

// A successor records its own identity at boot, after its source starts it.
const ownerRuns = new Map<string, { readonly run: OwnerRun; readonly expiresAt: number }>();
const deploymentProbes = new Map<
  string,
  { readonly result: Promise<boolean>; expiresAt: number }
>();

/** Whether the World replays each run on its original deployment (Vercel). */
export function routesToOwnerDeployment(world: Pick<World, "capabilities">): boolean {
  return world.capabilities?.deploymentAffinity === true;
}

async function readOwnerRun(world: Pick<World, "runs">, runId: string): Promise<OwnerRun> {
  const known = ownerRuns.get(runId);
  if (known !== undefined && known.expiresAt > Date.now()) return known.run;
  const run = await world.runs.get(runId, { resolveData: "none" });
  if (ownerRuns.size >= OWNER_CACHE_LIMIT) ownerRuns.clear();
  ownerRuns.set(runId, { run, expiresAt: Date.now() + OWNER_CACHE_TTL_MS });
  return run;
}

/** The owner when another eve version built it, or undefined when this build can replay it. */
export async function findRetiredOwnerRun(
  world: Pick<World, "runs">,
  runId: string,
): Promise<OwnerRun | undefined> {
  const run = await readOwnerRun(world, runId);
  return run.attributes[EVE_VERSION_ATTRIBUTE] === resolveInstalledPackageInfo().version
    ? undefined
    : run;
}

/**
 * Refuses an owner this World cannot replay, or one pinned to a definitively
 * deleted Vercel deployment. A missing URL or an uncertain probe is not proof
 * of deletion: ending a healthy session would cost its conversation.
 */
export async function findStrandedOwnerRun(
  world: Pick<World, "capabilities" | "runs">,
  runId: string,
): Promise<OwnerRun | undefined> {
  const run = await readOwnerRun(world, runId);
  if (
    !routesToOwnerDeployment(world) &&
    run.attributes[EVE_VERSION_ATTRIBUTE] !== resolveInstalledPackageInfo().version
  ) {
    return run;
  }
  const deploymentUrl = run.attributes[EVE_DEPLOYMENT_URL_ATTRIBUTE];
  if (
    deploymentUrl === undefined ||
    deploymentUrl === process.env.VERCEL_URL?.trim() ||
    run.deploymentId === process.env.VERCEL_DEPLOYMENT_ID?.trim() ||
    !isVercelDeploymentHost(deploymentUrl)
  ) {
    return undefined;
  }
  return (await isDeploymentGone(deploymentUrl)) ? run : undefined;
}

function isVercelDeploymentHost(host: string): boolean {
  try {
    const url = new URL(`https://${host}`);
    return url.hostname === host && url.port === "" && host.endsWith(".vercel.app");
  } catch {
    return false;
  }
}

async function isDeploymentGone(deploymentUrl: string): Promise<boolean> {
  const known = deploymentProbes.get(deploymentUrl);
  if (known !== undefined && known.expiresAt > Date.now()) return await known.result;
  // Deleted deployments can be restored during Vercel's recovery window.
  const probe = { result: probeDeployment(deploymentUrl), expiresAt: Infinity };
  if (deploymentProbes.size >= OWNER_CACHE_LIMIT) deploymentProbes.clear();
  deploymentProbes.set(deploymentUrl, probe);
  const gone = await probe.result;
  probe.expiresAt = Date.now() + OWNER_CACHE_TTL_MS;
  return gone;
}

async function probeDeployment(deploymentUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`https://${deploymentUrl}${EVE_HEALTH_ROUTE_PATH}`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(DEPLOYMENT_PROBE_TIMEOUT_MS),
    });
    const code = response.headers.get("x-vercel-error");
    return (
      (response.status === 404 && code === "DEPLOYMENT_NOT_FOUND") ||
      (response.status === 410 && code === "DEPLOYMENT_DELETED")
    );
  } catch {
    return false;
  }
}
