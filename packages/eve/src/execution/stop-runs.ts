import { WORKFLOW_CANCELLATION_SETTLE_MS } from "#execution/tools/workflow/cancellation-policy.js";
import type { WorkflowToolRunControlMessage } from "#execution/tools/workflow/messages.js";
import type { WorkflowToolRunAddress } from "#execution/tools/workflow/types.js";
import { isRunTargetGone } from "#shared/run-errors.js";
import { getBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { runtimeWait, storedProjection, turnPosition } from "#harness/session-machine/view.js";
import type { SessionStateMap } from "#harness/types.js";
import { cancelRoutedRun, resumeRoutedHook, routedRunLive } from "#execution/hosts.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("execution.stop-runs");

export type RunStop = Extract<WorkflowToolRunControlMessage, { readonly kind: "cancel" | "end" }>;

export interface RunStopTarget {
  readonly run: WorkflowToolRunAddress;
  readonly ends: boolean;
}

export function waitedCallRuns(session: {
  readonly sessionId: string;
  readonly state?: SessionStateMap;
}): RunStopTarget[] {
  try {
    const turnId =
      runtimeWait(session.state)?.event.turnId ??
      turnPosition(storedProjection(session.state)).turnId;
    return getBlockingWorkflowToolRuns(session.state, turnId).map((run) => ({
      ends: true,
      run: run.address,
    }));
  } catch (error) {
    logError(log, "failed to read the workflow tool calls a cancelled turn waits on", error, {
      sessionId: session.sessionId,
    });
    return [];
  }
}

export async function stopRuns(
  targets: readonly RunStopTarget[],
  stop: RunStop,
  options: { readonly waitForEnd?: boolean } = {},
): Promise<readonly string[]> {
  const signalled = await Promise.all(
    targets.map(async (target) => ({ target, told: await tell(target.run, stop) })),
  );
  const ending = signalled.filter(({ target }) => target.ends);
  const lingering =
    options.waitForEnd === false
      ? []
      : await runsStillRunning(
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
    await resumeRoutedHook(run.hookToken, stop);
    return true;
  } catch (error) {
    if (!isRunTargetGone(error)) {
      logError(log, "failed to tell a run to stop; cancelling it outright", error, {
        runId: run.runId,
      });
    }
    return false;
  }
}

async function runsStillRunning(runIds: readonly string[]): Promise<readonly string[]> {
  let running = runIds;
  const deadline = Date.now() + WORKFLOW_CANCELLATION_SETTLE_MS;
  while (running.length > 0 && Date.now() < deadline) {
    const statuses = await Promise.all(
      running.map(async (runId) => ({ runId, live: await routedRunLive(runId) })),
    );
    running = statuses.filter(({ live }) => live).map(({ runId }) => runId);
    if (running.length > 0) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return running;
}

async function cancelOutright(runId: string, reason: string): Promise<boolean> {
  try {
    return await cancelRoutedRun(runId, reason);
  } catch (error) {
    if (!isRunTargetGone(error)) {
      logError(log, "failed to cancel a run; it may run to completion", error, { runId });
    }
    return false;
  }
}
