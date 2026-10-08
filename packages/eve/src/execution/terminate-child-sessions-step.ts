import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { liveRuns, stopRuns } from "#execution/stop-runs.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("execution.terminate-child-sessions");

/**
 * Session end ends every run the session started, including cancelled runs that haven't
 * confirmed yet. Each run ends the agent sessions it opened.
 */
export async function terminateChildSessionsStep(input: {
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  "use step";

  let runs;
  try {
    runs = liveRuns(readDurableSession(input.sessionState).state);
  } catch (error) {
    logError(log, "failed to read child sessions for termination", error, {
      parentSessionId: input.sessionState.sessionId,
    });
    return;
  }
  await stopRuns(
    runs.map((run) => ({ ends: true, run })),
    { kind: "end", reason: "The session ended." },
  );
}
