import type { RunControlMessage } from "#execution/tool-run/messages.js";
import type { ToolRunAddress } from "#execution/tool-run/types.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { cancelRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("execution.tool-run");

/**
 * Cancels one workflow tool run with a `cancel` control message: the body
 * observes `ctx.abortSignal`, unwinds, and the run ends itself as cancelled
 * after its grace period. A run that already finished is not an error. If the
 * message cannot be delivered, the run is cancelled outright; a failure there
 * is logged rather than thrown, because the caller has already committed the
 * cancellation the run was serving and must not roll it back.
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
