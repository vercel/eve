import { queuedInput, storedProjection } from "#harness/session-machine/view.js";
import { openInputs, openSignIns } from "#protocol/session-projection.js";
import { getBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { holdsHitlRequests } from "#harness/hitl/view.js";
import { readDurableSession } from "#execution/durable-session-read.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";

/** Parses retained work with this deployment's code before deciding whether it can move. */
export function isSessionStateIdleForHandoff(input: {
  readonly sessionState: DurableSessionState;
}): boolean {
  const { state } = readDurableSession(input.sessionState);
  // Decoding the run registry rejects corrupt state before any busy-work shortcut.
  const workflowToolRuns = getBlockingWorkflowToolRuns(state);

  // These registries are deleted when work settles. Their ordinary readers
  // tolerate malformed values as absent; that must not authorize a handoff.
  if (holdsHitlRequests(state)) return false;
  const pendingKeys = [
    "eve.runtime.pendingInputBatch",
    "eve.runtime.pendingCoordinationBatch",
    "eve.runtime.deferredStepInput",
    "eve.harness.pendingWorkflowInterrupt",
  ];
  if (pendingKeys.some((key) => state?.[key] !== undefined)) return false;
  const batches = state?.["eve.runtime.pendingInputBatches"];
  if (batches !== undefined && (!Array.isArray(batches) || batches.length > 0)) return false;
  const projection = storedProjection(state);
  return (
    workflowToolRuns.length === 0 &&
    projection.activeTurnId === undefined &&
    openInputs(projection).length === 0 &&
    openSignIns(projection).length === 0 &&
    queuedInput(state) === undefined
  );
}
