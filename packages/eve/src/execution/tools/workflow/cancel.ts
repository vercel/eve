import type { WorkflowToolRunControlMessage } from "#execution/tools/workflow/messages.js";
import type { WorkflowToolRunAddress } from "#execution/tools/workflow/types.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { cancelRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("execution.workflow-tool-run");

/**
 * Asks the run to cancel itself; cancels it outright only if the message cannot
 * be delivered. Failures are logged, not thrown: the caller has already
 * committed the cancellation the run was serving.
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
    await cancelRun(await getWorld(), run.runId, { cancelReason: reason });
  } catch (error) {
    if (isTaskWorkflowTargetGone(error)) return;
    logError(log, "failed to cancel workflow tool run; it may run to completion", error, {
      runId: run.runId,
    });
  }
}

export async function cancelWorkflowToolRunStep(input: {
  readonly reason: string;
  readonly run: WorkflowToolRunAddress;
}): Promise<void> {
  "use step";

  await cancelWorkflowToolRun(input.run, input.reason);
}
