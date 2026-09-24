import type { WorkflowToolRunOutcomeMessage } from "#execution/tools/workflow/messages.js";
import { rebuildSerializableError } from "#execution/workflow-errors.js";
import { createLogger, logError } from "#internal/logging.js";

/**
 * Logs a workflow tool run outcome that never reached the run's owner. The
 * run still returns the outcome, so the owner's deadline read settles the
 * call with it. The workflow body cannot import the logger, so the report
 * crosses a step boundary.
 */
export async function logUndeliveredWorkflowOutcomeStep(input: {
  readonly error: unknown;
  readonly message: WorkflowToolRunOutcomeMessage;
}): Promise<void> {
  "use step";

  const { from, result } = input.message;
  logError(
    createLogger("execution.workflow-tool-run"),
    "a workflow tool run could not report its outcome to its owner",
    rebuildSerializableError(input.error),
    {
      callId: from.callId,
      runId: from.runId,
      status: result.status,
      taskId: from.taskId,
    },
  );
}
