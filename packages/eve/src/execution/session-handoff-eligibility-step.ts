import type { DurableSessionState } from "#execution/durable-session-store.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { getPendingAuthorization } from "#harness/authorization.js";
import { getPendingCoordinationBatch } from "#harness/coordination.js";
import { hasPendingInputBatch } from "#harness/input-requests.js";
import { getWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { getAgentHandleStore } from "#subagents/handles/store.js";
import { getSessionTaskIndex } from "#tasks/session-index.js";

/** Reads every durable work registry used by handoff eligibility. */
export async function isSessionIdleForHandoffStep(input: {
  readonly sessionState: DurableSessionState;
}): Promise<boolean> {
  "use step";

  const session = await readDurableSession(input.sessionState);
  const state = session.state;
  if (getPendingAuthorization(state) !== undefined || hasPendingInputBatch(state)) return false;
  if (getPendingCoordinationBatch(state) !== undefined) return false;
  if (getWorkflowToolRuns(state).length > 0) return false;
  if ((getAgentHandleStore(state)?.handles.length ?? 0) > 0) return false;
  return getSessionTaskIndex(state).every((task) => task.terminalView !== undefined);
}
