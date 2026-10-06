import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { cancelWorkflowToolRun } from "#execution/tools/workflow/cancel.js";
import {
  getBlockingWorkflowToolRuns,
  type BlockingWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import { createLogger, logError } from "#internal/logging.js";
import { runtimeWait, storedProjection, turnPosition } from "#harness/session-machine/view.js";

const log = createLogger("execution.cancel-descendant-turns");

/** Cancels every workflow tool run the turn is waiting on. */
export async function cancelDescendantTurnsStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  "use step";

  let workflowToolRuns: readonly BlockingWorkflowToolRun[];
  try {
    const session = readDurableSession(input.sessionState);
    workflowToolRuns = getBlockingWorkflowToolRuns(
      session.state,
      runtimeWait(session.state)?.event.turnId ??
        turnPosition(storedProjection(session.state)).turnId,
    );
  } catch (error) {
    logError(log, "failed to read pending descendants during cancellation", error, {
      sessionId: input.sessionState.sessionId,
    });
    return;
  }

  await Promise.all(
    workflowToolRuns.map((record) =>
      cancelWorkflowToolRun(record.address, {
        kind: "cancel",
        reason: "The turn that called the tool was cancelled.",
      }),
    ),
  );
}
