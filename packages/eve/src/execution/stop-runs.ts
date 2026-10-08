import { WORKFLOW_CANCELLATION_SETTLE_MS } from "#execution/tools/workflow/cancellation-policy.js";
import type { WorkflowToolRunControlMessage } from "#execution/tools/workflow/messages.js";
import type { WorkflowToolRunAddress } from "#execution/tools/workflow/types.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { liveTaskRuns, readTaskTable } from "#execution/tasks/table.js";
import { getBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import type { SessionStateMap } from "#harness/types.js";
import { cancelRun, getRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("execution.stop-runs");

/** How a run is told to stop: `end` also finishes a `serve` task's run, which a cancel keeps. */
export type RunStop = Extract<WorkflowToolRunControlMessage, { readonly kind: "cancel" | "end" }>;

/** One run to stop. */
export interface RunStopTarget {
  readonly run: WorkflowToolRunAddress;
  /**
   * Whether the stop ends the run. A resumable task's cancel stops only its current stretch of
   * work, and its run stays parked for later calls, so nothing waits for it to end.
   */
  readonly ends: boolean;
}

/**
 * Every run the session started and hasn't seen finish: the calls a turn waits on, and every
 * task's run, including cancelled runs that haven't confirmed yet.
 */
export function liveRuns(state: SessionStateMap | undefined): readonly WorkflowToolRunAddress[] {
  return [
    ...getBlockingWorkflowToolRuns(state).map((run) => run.address),
    ...liveTaskRuns(readTaskTable(state)),
  ];
}

/**
 * Stops runs, the same way whoever stops them: each is told to stop, a run the stop ends gets
 * until the deadline to finish cleaning up, and one still running then is cancelled outright.
 * So is a run that couldn't be told, such as one that hasn't registered its control hook yet.
 * Returns the runs cancelled outright, which never report how they ended.
 */
export async function stopRuns(
  targets: readonly RunStopTarget[],
  stop: RunStop,
): Promise<readonly string[]> {
  const signalled = await Promise.all(
    targets.map(async (target) => ({ target, told: await tell(target.run, stop) })),
  );
  const ending = signalled.filter(({ target }) => target.ends);
  const lingering = await runsStillRunning(
    ending.filter(({ told }) => told).map(({ target }) => target.run.runId),
  );
  const unreachable = ending.filter(({ told }) => !told).map(({ target }) => target.run.runId);
  const cancelled = await Promise.all(
    [...unreachable, ...lingering].map(async (runId) =>
      (await cancelOutright(runId, stop.reason)) ? [runId] : [],
    ),
  );
  return cancelled.flat();
}

async function tell(run: WorkflowToolRunAddress, stop: RunStop): Promise<boolean> {
  try {
    await resumeHook(run.hookToken, stop);
    return true;
  } catch (error) {
    // A fresh run may not have registered its control hook yet.
    if (!isTaskWorkflowTargetGone(error)) {
      logError(log, "failed to tell a run to stop; cancelling it outright", error, {
        runId: run.runId,
      });
    }
    return false;
  }
}

/** Waits until every run finishes or the deadline passes, and returns the ones still running. */
async function runsStillRunning(runIds: readonly string[]): Promise<readonly string[]> {
  let running = runIds;
  const deadline = Date.now() + WORKFLOW_CANCELLATION_SETTLE_MS;
  while (running.length > 0 && Date.now() < deadline) {
    const statuses = await Promise.all(
      running.map(async (runId) => ({ runId, live: await isRunLive(runId) })),
    );
    running = statuses.filter(({ live }) => live).map(({ runId }) => runId);
    if (running.length > 0) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return running;
}

/** A run whose status can't be read counts as live, so the deadline still stops it. */
async function isRunLive(runId: string): Promise<boolean> {
  try {
    const status = await getRun(runId).status;
    return status === "pending" || status === "running";
  } catch (error) {
    return !isTaskWorkflowTargetGone(error);
  }
}

/** True when the run was still live and is now cancelled. */
async function cancelOutright(runId: string, reason: string): Promise<boolean> {
  try {
    await cancelRun(await getWorld(), runId, { cancelReason: reason });
    return true;
  } catch (error) {
    if (!isTaskWorkflowTargetGone(error)) {
      logError(log, "failed to cancel a run; it may run to completion", error, { runId });
    }
    return false;
  }
}
