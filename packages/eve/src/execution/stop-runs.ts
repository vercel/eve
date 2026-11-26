import { getStepMetadata } from "#compiled/@workflow/core/index.js";
import { WORKFLOW_CANCELLATION_SETTLE_MS } from "#execution/tools/workflow/cancellation-policy.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import type { TaskRunAddress } from "#execution/tasks/table.js";
import type { WorkflowToolRunControlMessage } from "#execution/tools/workflow/messages.js";
import { isRunTargetGone } from "#shared/run-errors.js";
import { getBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { runtimeWait, storedProjection, turnPosition } from "#harness/session-machine/view.js";
import type { SessionStateMap } from "#harness/types.js";
import {
  cancelRoutedRun,
  resolveRoutedSessionOwnerRunId,
  resumeRoutedHook,
  routedRunLive,
} from "#execution/hosts.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("execution.stop-runs");

export type RunStop = Extract<WorkflowToolRunControlMessage, { readonly kind: "cancel" | "end" }>;

export interface RunStopTarget {
  readonly run: TaskRunAddress;
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
      : await runsStillRunning(ending.filter(({ told }) => told).map(({ target }) => target.run));
  const unreachable = ending.filter(({ told }) => !told).map(({ target }) => target.run);
  const cancelled = await Promise.all(
    [...unreachable, ...lingering].map(async (run) =>
      (await cancelOutright(run, stop.reason)) ? [run.runId] : [],
    ),
  );
  return cancelled.flat();
}

function stepScopedId(fallback: string): string {
  try {
    return getStepMetadata().stepId || fallback;
  } catch {
    return fallback;
  }
}

async function resolveOwnerRunId(run: TaskRunAddress): Promise<string> {
  if (run.directAgent === undefined) return run.runId;
  try {
    return (await resolveRoutedSessionOwnerRunId(run.directAgent.continuationToken)) ?? run.runId;
  } catch {
    return run.runId;
  }
}

async function tell(run: TaskRunAddress, stop: RunStop): Promise<boolean> {
  const payload =
    run.directAgent !== undefined
      ? stop.kind === "end"
        ? {
            deliveryId: `direct-agent:reset:${stepScopedId(run.runId)}:${run.runId}`,
            kind: "reset",
            reason: stop.reason,
          }
        : {
            deliveryId: `direct-agent:cancel:${stepScopedId(run.runId)}:${run.runId}`,
            kind: "cancel",
          }
      : stop;
  try {
    await resumeRoutedHook(run.hookToken, payload);
    return true;
  } catch (error) {
    if (run.directAgent !== undefined && isRunTargetGone(error)) {
      try {
        await resumeRoutedHook(sessionInboxHookToken(run.directAgent.continuationToken), payload);
        return true;
      } catch (fallbackError) {
        if (!isRunTargetGone(fallbackError)) {
          logError(log, "failed to tell a run to stop; cancelling it outright", fallbackError, {
            runId: run.runId,
          });
        }
        return false;
      }
    }
    if (!isRunTargetGone(error)) {
      logError(log, "failed to tell a run to stop; cancelling it outright", error, {
        runId: run.runId,
      });
    }
    return false;
  }
}

async function runsStillRunning(
  runs: readonly TaskRunAddress[],
): Promise<readonly TaskRunAddress[]> {
  let running = await Promise.all(
    runs.map(async (run) => ({ ownerRunId: await resolveOwnerRunId(run), run })),
  );
  const deadline = Date.now() + WORKFLOW_CANCELLATION_SETTLE_MS;
  while (running.length > 0 && Date.now() < deadline) {
    const statuses = await Promise.all(
      running.map(async (entry) => ({ ...entry, live: await routedRunLive(entry.ownerRunId) })),
    );
    running = statuses.filter(({ live }) => live);
    if (running.length > 0) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return running.map(({ run }) => run);
}

async function cancelOutright(run: TaskRunAddress, reason: string): Promise<boolean> {
  try {
    const ownerRunId = await resolveOwnerRunId(run);
    return await cancelRoutedRun(ownerRunId, reason);
  } catch (error) {
    if (!isRunTargetGone(error)) {
      logError(log, "failed to cancel a run; it may run to completion", error, {
        runId: run.runId,
      });
    }
    return false;
  }
}
