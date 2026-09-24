import { getPendingCoordinationBatch } from "#harness/coordination.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { cancelWorkflowToolRun } from "#execution/tools/workflow/cancel.js";
import {
  getBlockingWorkflowToolRuns,
  type BlockingWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("execution.cancel-descendant-turns");

/**
 * Cancels every workflow tool run the turn is waiting on. Agent tasks are
 * cancelled by the owner's task table, which never waits for them.
 */
export async function cancelDescendantTurnsStep(input: {
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  "use step";

  let workflowToolRuns: readonly BlockingWorkflowToolRun[];
  try {
    const session = readDurableSession(input.sessionState);
    workflowToolRuns = getBlockingWorkflowToolRuns(
      session.state,
      getPendingCoordinationBatch(session.state)?.event.turnId ??
        input.sessionState.emissionState.turnId,
    );
  } catch (error) {
    logError(log, "failed to read pending workflow tool runs during cancellation", error, {
      sessionId: input.sessionState.sessionId,
    });
    return;
  }

  await Promise.all(
    workflowToolRuns.map((record) =>
      cancelWorkflowToolRun(record.address, "The turn that called the tool was cancelled."),
    ),
  );
}
