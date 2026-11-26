import type { World } from "#compiled/@workflow/world/index.js";
import { EVE_TYPE_ATTRIBUTE, EVE_VERSION_ATTRIBUTE } from "#execution/eve-workflow-attributes.js";
import {
  findRetiredOwnerRun,
  routesToOwnerDeployment,
  type OwnerRun,
} from "#execution/session-inbox/runnable-owner.js";
import {
  SESSION_TIMEOUT_WORKFLOW_NAME,
  SUBSCRIPTION_DELIVERY_WORKFLOW_NAME,
  SUBSCRIPTION_KEY_WORKFLOW_NAME,
  SUBSCRIPTION_WORKFLOW_NAME,
  TURN_WORKFLOW_NAME,
  WORKFLOW_ENTRY_NAME,
  WORKFLOW_TOOL_RUN_WORKFLOW_NAME,
  type StableWorkflowName,
} from "#execution/stable-workflow-names.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createLogger } from "#internal/logging.js";
import { isRunInactive, isRunMissing } from "#shared/run-errors.js";
import { cancelRun } from "#internal/workflow/runtime.js";

const log = createLogger("execution.session-inbox.stranded-replay-guard");

type StrandedRun = "session" | "retire" | "replay";

const STRANDED_RUNS: Readonly<Record<StableWorkflowName, StrandedRun>> = {
  [WORKFLOW_ENTRY_NAME]: "session",
  [TURN_WORKFLOW_NAME]: "session",
  [WORKFLOW_TOOL_RUN_WORKFLOW_NAME]: "retire",
  [SUBSCRIPTION_WORKFLOW_NAME]: "retire",
  [SUBSCRIPTION_KEY_WORKFLOW_NAME]: "retire",
  [SESSION_TIMEOUT_WORKFLOW_NAME]: "replay",
  [SUBSCRIPTION_DELIVERY_WORKFLOW_NAME]: "replay",
};

export function guardStrandedSessionReplay<TWorld extends World>(world: TWorld): TWorld {
  if (routesToOwnerDeployment(world)) return world;
  const { name } = resolveInstalledPackageInfo();
  const guardedWorkflows = new Map<string, GuardedWorkflow>();
  for (const [workflow, stranded] of Object.entries(STRANDED_RUNS)) {
    if (stranded !== "replay") guardedWorkflows.set(`workflow//${name}//${workflow}`, stranded);
  }
  const createQueueHandler = world.createQueueHandler.bind(world);
  world.createQueueHandler = (queueNamePrefix, handler) =>
    createQueueHandler(queueNamePrefix, async (message, meta) => {
      const workflow = guardedWorkflows.get(meta.queueName.slice(queueNamePrefix.length));
      const runId = readRunId(message);
      if (
        workflow !== undefined &&
        runId !== undefined &&
        (await skipRetiredRun(world, runId, workflow))
      ) {
        return undefined;
      }
      return await handler(message, meta);
    });
  return world;
}

type GuardedWorkflow = Exclude<StrandedRun, "replay">;

async function skipRetiredRun(
  world: World,
  runId: string,
  workflow: GuardedWorkflow,
): Promise<boolean> {
  const run = await readRetiredRun(world, runId);
  if (run === undefined) return false;
  switch (strandedReplayAction(run, workflow)) {
    case "replay":
      return false;
    case "retire":
      await retireRun(world, run);
      return true;
    case "park":
      logParkedSession(run);
      return true;
  }
}

function strandedReplayAction(
  run: OwnerRun,
  workflow: GuardedWorkflow,
): "park" | "replay" | "retire" {
  if (run.status !== "pending" && run.status !== "running") return "replay";
  return workflow === "retire" || run.attributes[EVE_TYPE_ATTRIBUTE] === "subagent"
    ? "retire"
    : "park";
}

async function readRetiredRun(world: World, runId: string): Promise<OwnerRun | undefined> {
  try {
    return await findRetiredOwnerRun(world, runId);
  } catch (error) {
    if (isRunMissing(error)) return undefined;
    throw error;
  }
}

async function retireRun(world: World, run: OwnerRun): Promise<void> {
  try {
    await cancelRun(world, run.runId, {
      cancelReason: "Run retired: its eve deployment is no longer available",
    });
  } catch (error) {
    if (!isRunInactive(error)) throw error;
  }
  log.warn("Retired stranded run", {
    runId: run.runId,
    workflowName: run.workflowName,
    previousEveVersion: run.attributes[EVE_VERSION_ATTRIBUTE] ?? "unknown",
    currentEveVersion: resolveInstalledPackageInfo().version,
  });
}

function logParkedSession(run: OwnerRun): void {
  log.warn(
    `Skipping replay of stranded session run "${run.runId}" (owner eve ${run.attributes[EVE_VERSION_ATTRIBUTE] ?? "unknown"}, current ${resolveInstalledPackageInfo().version}). It remains active until an ordinary channel message, an explicit reset, or its session timeout ends it.`,
  );
}

function readRunId(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null || "__healthCheck" in message) {
    return undefined;
  }
  const runId = (message as { readonly runId?: unknown }).runId;
  return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}
