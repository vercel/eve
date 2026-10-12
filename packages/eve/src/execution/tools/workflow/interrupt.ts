import { getStepMetadata } from "#compiled/@workflow/core/index.js";
import { RetryableError } from "#compiled/@workflow/errors/index.js";
import { isWorkflowToolRunLive } from "#execution/tools/workflow/cancel.js";
import type { WorkflowToolRunControlMessage } from "#execution/tools/workflow/messages.js";
import type { WorkflowToolRunAddress } from "#execution/tools/workflow/types.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { createLogger, logError } from "#internal/logging.js";

const INTERRUPT: WorkflowToolRunControlMessage = { kind: "interrupt" };
const INTERRUPT_MAX_RETRIES = 60;
const log = createLogger("execution.workflow-tool-run");

/**
 * Aborts the `execute` call's `abortSignal`. A fresh run may not have registered
 * its hook yet: retry every second for a minute while it starts, then drop this best-effort steer
 * instead of failing the calling turn when the durable retry budget runs out.
 */
export async function interruptWorkflowToolRun(run: WorkflowToolRunAddress): Promise<void> {
  "use step";

  try {
    try {
      await resumeHook(run.hookToken, INTERRUPT);
    } catch (error) {
      if (!isTaskWorkflowTargetGone(error)) throw error;
      if (!(await isWorkflowToolRunLive(run.runId))) return;
      throw new RetryableError("Workflow tool control hook is not registered yet", {
        retryAfter: "1s",
      });
    }
  } catch (error) {
    if (getStepMetadata().attempt <= INTERRUPT_MAX_RETRIES) throw error;
    logError(log, "failed to interrupt workflow tool run; dropping best-effort steer", error, {
      runId: run.runId,
    });
  }
}

(interruptWorkflowToolRun as typeof interruptWorkflowToolRun & { maxRetries: number }).maxRetries =
  INTERRUPT_MAX_RETRIES;
