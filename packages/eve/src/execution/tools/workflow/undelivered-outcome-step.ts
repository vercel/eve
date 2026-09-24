import type { WorkflowToolRunOutcomeMessage } from "#execution/tools/workflow/messages.js";
import { rebuildSerializableError } from "#execution/workflow-errors.js";
import { createLogger, logError } from "#internal/logging.js";

/**
 * Logs a workflow tool run outcome that never reached the run's owner. With
 * `error`, delivery failed: the run still returns the outcome, so the owner's
 * deadline read settles a call with a time limit with it. Without `error`,
 * the owner session had already ended, so nothing waits for the outcome. The
 * workflow body cannot import the logger, so the report crosses a step
 * boundary.
 */
export async function logUndeliveredWorkflowOutcomeStep(input: {
  readonly error?: unknown;
  readonly message: WorkflowToolRunOutcomeMessage;
}): Promise<void> {
  "use step";

  const { from, result } = input.message;
  const log = createLogger("execution.workflow-tool-run");
  const fields = {
    callId: from.callId,
    runId: from.runId,
    status: result.status,
    taskId: from.taskId,
  };
  if (input.error === undefined) {
    log.warn("a workflow tool run finished after its owner session ended", fields);
    return;
  }
  logError(
    log,
    "a workflow tool run could not report its outcome to its owner",
    rebuildSerializableError(input.error),
    fields,
  );
}
