import type {
  WorkflowToolRunGenerationMessage,
  WorkflowToolRunOutcomeMessage,
} from "#execution/tools/workflow/messages.js";
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

/**
 * Logs a resumable run's lifecycle message that never reached its owner. The
 * run goes on, so its later messages, and the task's end, still go out.
 */
export async function logUndeliveredGenerationStep(input: {
  readonly error: unknown;
  readonly message: WorkflowToolRunGenerationMessage;
}): Promise<void> {
  "use step";

  const { from, kind } = input.message;
  logError(
    createLogger("execution.workflow-tool-run"),
    "a resumable workflow tool run could not report to its owner",
    rebuildSerializableError(input.error),
    { generation: from.generation, kind, runId: from.runId, taskId: from.taskId },
  );
}

/**
 * Logs the result of a resumable body that returned a value or threw after
 * its generation's reply. The reply was that generation's one result, so the
 * value or error reaches no one; the task still ends.
 */
export async function logIgnoredWorkflowResultStep(input: {
  readonly from: WorkflowToolRunOutcomeMessage["from"];
  readonly result: WorkflowToolRunOutcomeMessage["result"];
}): Promise<void> {
  "use step";

  const { from, result } = input;
  const log = createLogger("execution.workflow-tool-run");
  const fields = { callId: from.callId, runId: from.runId, taskId: from.taskId };
  if (result.status === "failed") {
    logError(
      log,
      "a resumable workflow tool threw after its reply; the task ended",
      rebuildSerializableError(result.error),
      fields,
    );
    return;
  }
  log.warn(
    "a resumable workflow tool returned a value after its reply; the value was dropped and the task ended",
    fields,
  );
}
