import {
  readDurableSession,
  type DurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { cancelWorkflowToolRun } from "#execution/tools/workflow/cancel.js";
import { liveTaskRuns, readTaskTable } from "#execution/tasks/table.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("execution.terminate-child-sessions");

/**
 * Session end ends every task, including cancelled runs that haven't
 * confirmed yet. Each run ends the agent sessions it opened.
 */
export async function terminateChildSessionsStep(input: {
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  "use step";

  let session: DurableSession;
  try {
    session = readDurableSession(input.sessionState);
  } catch (error) {
    logError(log, "failed to read child sessions for termination", error, {
      parentSessionId: input.sessionState.sessionId,
    });
    return;
  }

  await stopTaskRuns(session);
}

async function stopTaskRuns(session: DurableSession): Promise<void> {
  const runs = liveTaskRuns(readTaskTable(session.state));
  await Promise.all(
    runs.map((run) => cancelWorkflowToolRun(run, { kind: "end", reason: "The session ended." })),
  );
}
