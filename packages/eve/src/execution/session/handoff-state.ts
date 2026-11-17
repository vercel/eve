import { activeTurnIdOf } from "#protocol/session-projection.js";
import { queuedInput, storedProjection } from "#harness/session-machine/view.js";
import { openRequests, openSignIns } from "#protocol/session-projection/reader.js";
import { getBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { holdsHitlRequests } from "#harness/hitl/view.js";
import { readDurableSession } from "#execution/durable-session-read.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";

export function isSessionStateIdleForHandoff(input: {
  readonly sessionState: DurableSessionState;
}): boolean {
  const { state } = readDurableSession(input.sessionState);
  const workflowToolRuns = getBlockingWorkflowToolRuns(state);

  if (holdsHitlRequests(state)) return false;
  const projection = storedProjection(state);
  return (
    workflowToolRuns.length === 0 &&
    activeTurnIdOf(projection) === undefined &&
    openRequests(projection.view).length === 0 &&
    openSignIns(projection.view).length === 0 &&
    queuedInput(state) === undefined
  );
}
