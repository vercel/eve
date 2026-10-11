import type { World } from "#compiled/@workflow/world/index.js";
import { EVE_TYPE_ATTRIBUTE, EVE_VERSION_ATTRIBUTE } from "#execution/eve-workflow-attributes.js";
import {
  findRetiredOwnerRun,
  routesToOwnerDeployment,
  type OwnerRun,
} from "#execution/session-inbox/runnable-owner.js";
import {
  WORKFLOW_ENTRY_NAME,
  WORKFLOW_TOOL_RUN_WORKFLOW_NAME,
} from "#execution/stable-workflow-names.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createLogger } from "#internal/logging.js";
import {
  isInactiveWorkflowRunError,
  isMissingWorkflowRunError,
} from "#internal/workflow/is-inactive-workflow-run-error.js";
import { cancelRun } from "#internal/workflow/runtime.js";

const log = createLogger("execution.session-inbox.stranded-replay-guard");

/**
 * Makes the World acknowledge, without replaying, queue deliveries for
 * top-level eve session runs that another eve version started. Worlds that
 * re-enqueue their active runs at startup (local, Postgres) would otherwise
 * replay such a run on this build's code and fail it as `CORRUPTED_EVENT_LOG`.
 * A top-level session stays active until ingress replaces it or its timeout
 * ends it. Subagent sessions and workflow tool runs are cancelled instead:
 * no later user message can replace their interrupted work. Ingress refuses
 * the same owners by the same verdict, so preserved owners cannot admit work.
 * Timeout workflows remain runnable so they can end preserved sessions.
 *
 * Mutates and returns `world`; only its `createQueueHandler` changes. Worlds
 * that replay each run on its own deployment are returned untouched.
 */
export function guardStrandedSessionReplay<TWorld extends World>(world: TWorld): TWorld {
  if (routesToOwnerDeployment(world)) return world;
  const { name } = resolveInstalledPackageInfo();
  const guardedWorkflows = new Map<string, GuardedWorkflow>([
    [`workflow//${name}//${WORKFLOW_ENTRY_NAME}`, "session"],
    [`workflow//${name}//${WORKFLOW_TOOL_RUN_WORKFLOW_NAME}`, "tool"],
  ]);
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

type GuardedWorkflow = "session" | "tool";

/** Applies {@link strandedReplayAction}; true when the delivery must not replay. */
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

/**
 * What to do with a delivery for a retired run. Only an active run needs a
 * verdict. A top-level session parks so ingress or its timeout can replace or
 * end it; a subagent session or workflow tool run is retired, because no
 * later user message can replace its interrupted work.
 */
function strandedReplayAction(
  run: OwnerRun,
  workflow: GuardedWorkflow,
): "park" | "replay" | "retire" {
  if (run.status !== "pending" && run.status !== "running") return "replay";
  return workflow === "tool" || run.attributes[EVE_TYPE_ATTRIBUTE] === "subagent"
    ? "retire"
    : "park";
}

/** The run when another eve version started it; `undefined` when this build can replay it. */
async function readRetiredRun(world: World, runId: string): Promise<OwnerRun | undefined> {
  try {
    return await findRetiredOwnerRun(world, runId);
  } catch (error) {
    // A resilient start enqueues before its run is readable; such a run is new.
    if (isMissingWorkflowRunError(error)) return undefined;
    // Anything else is retried by the queue: replaying a retired run would corrupt it.
    throw error;
  }
}

async function retireRun(world: World, run: OwnerRun): Promise<void> {
  try {
    await cancelRun(world, run.runId, {
      cancelReason: "Run retired: its eve deployment is no longer available",
    });
  } catch (error) {
    // A concurrent cancellation or completion has already retired the run.
    if (!isInactiveWorkflowRunError(error)) throw error;
  }
  log.warn("Retired stranded descendant run", {
    runId: run.runId,
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
