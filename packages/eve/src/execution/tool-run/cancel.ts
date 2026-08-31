import type { RunControlMessage } from "#execution/tool-run/messages.js";
import type { ToolRunAddress } from "#execution/tool-run/types.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { cancelRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("execution.tool-run");

/**
 * Asks the run to cancel itself; cancels it outright only if the message cannot
 * be delivered. Failures are logged, not thrown: the caller has already
 * committed the cancellation the run was serving.
 */
export async function cancelToolRun(run: ToolRunAddress, reason: string): Promise<void> {
  const cancel: RunControlMessage = { kind: "cancel", reason };
  try {
    await resumeHook(run.hookToken, cancel);
    return;
  } catch (error) {
    if (isTaskWorkflowTargetGone(error)) return;
    logError(log, "failed to signal a workflow tool run to cancel; cancelling it outright", error, {
      runId: run.runId,
    });
  }

  try {
    await cancelRun(await getWorld(), run.runId, { cancelReason: reason });
  } catch (error) {
    if (isTaskWorkflowTargetGone(error)) return;
    logError(log, "failed to cancel workflow tool run; it may run to completion", error, {
      runId: run.runId,
    });
  }
}
