import type { WorkflowToolRunControlMessage } from "#execution/tools/workflow/messages.js";
import type { WorkflowToolRunAddress } from "#execution/tools/workflow/types.js";
import { isWorkflowTargetGone } from "#execution/tools/workflow/target-gone.js";
import { cancelRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("execution.workflow-tool-run");

/**
 * Asks the run to cancel itself and returns without waiting: the run cleans
 * up and reports its cancelled outcome to the owner. A run whose control hook
 * cannot be reached is cancelled outright. Failures are logged, because the
 * owner has already recorded the cancellation.
 */
export async function cancelWorkflowToolRun(
  run: WorkflowToolRunAddress,
  reason: string,
): Promise<void> {
  const cancel: WorkflowToolRunControlMessage = { kind: "cancel", reason };
  try {
    await resumeHook(run.hookToken, cancel);
    return;
  } catch (error) {
    // A fresh run may not have registered its control hook yet.
    if (!isWorkflowTargetGone(error)) {
      logError(
        log,
        "failed to signal a workflow tool run to cancel; cancelling it outright",
        error,
        { runId: run.runId },
      );
    }
  }

  try {
    await cancelRun(await getWorld(), run.runId, { cancelReason: reason });
  } catch (error) {
    if (isWorkflowTargetGone(error)) return;
    logError(log, "failed to cancel workflow tool run; it may run to completion", error, {
      runId: run.runId,
    });
  }
}
