import { WORKFLOW_CANCELLATION_SETTLE_MS } from "#execution/tools/workflow/cancellation-policy.js";
import type { WorkflowToolRunControlMessage } from "#execution/tools/workflow/messages.js";
import type { WorkflowToolRunAddress } from "#execution/tools/workflow/types.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { cancelRun, getRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("execution.workflow-tool-run");

/** How a run is told to stop: `end` also finishes a `serve` task's run, which a cancel keeps. */
export type WorkflowToolRunStop = Extract<
  WorkflowToolRunControlMessage,
  { readonly kind: "cancel" | "end" }
>;

/**
 * Asks the run to stop itself, then bounds cooperative cleanup. Failures are
 * logged: the caller has already committed cancellation of the calling turn.
 */
export async function cancelWorkflowToolRun(
  run: WorkflowToolRunAddress,
  stop: WorkflowToolRunStop,
): Promise<void> {
  const { reason } = stop;
  let signalled = false;
  try {
    await resumeHook(run.hookToken, stop);
    signalled = true;
  } catch (error) {
    // A fresh run may not have registered its control hook yet.
    if (!isTaskWorkflowTargetGone(error)) {
      logError(
        log,
        "failed to signal a workflow tool run to cancel; cancelling it outright",
        error,
        {
          runId: run.runId,
        },
      );
    }
  }

  try {
    await settleWorkflowToolRunCancellation(run.runId, reason, signalled);
  } catch (error) {
    if (isTaskWorkflowTargetGone(error)) return;
    logError(log, "failed to cancel workflow tool run; it may run to completion", error, {
      runId: run.runId,
    });
  }
}

/** Allows cooperative cleanup, then forcibly stops a still-live run. */
export async function settleWorkflowToolRunCancellation(
  runId: string,
  reason: string,
  cooperative = true,
): Promise<void> {
  if (cooperative) {
    const deadline = Date.now() + WORKFLOW_CANCELLATION_SETTLE_MS;
    while (Date.now() < deadline) {
      try {
        const status = await getRun(runId).status;
        if (status !== "pending" && status !== "running") return;
      } catch (error) {
        if (isTaskWorkflowTargetGone(error)) return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  try {
    await cancelRun(await getWorld(), runId, { cancelReason: reason });
  } catch (error) {
    if (isTaskWorkflowTargetGone(error)) return;
    throw error;
  }
}
