import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { getAgentHandleStore } from "#subagents/handles/store.js";
import { getSessionTaskIndex } from "#tasks/session-index.js";
import { isObject } from "#shared/guards.js";

/** Parses retained work with this deployment's code before deciding whether it can move. */
export function isSessionStateIdleForHandoff(sessionState: DurableSessionState): boolean {
  const { state } = readDurableSession(sessionState);
  // Parse all entries, including terminal tasks, before any busy-work shortcut.
  const tasks = getSessionTaskIndex(state);
  const handles = getAgentHandleStore(state);

  // These registries are deleted when work settles. Their ordinary readers
  // tolerate malformed values as absent; that must not authorize a handoff.
  const pendingKeys = [
    "eve.runtime.pendingAuthorization",
    "eve.runtime.pendingInputBatch",
    "eve.runtime.pendingCoordinationBatch",
    "eve.runtime.deferredStepInput",
    "eve.harness.pendingWorkflowInterrupt",
  ];
  if (pendingKeys.some((key) => state?.[key] !== undefined)) return false;
  for (const key of ["eve.runtime.pendingInputBatches", "eve.runtime.workflowToolRuns"]) {
    const value = state?.[key];
    if (value !== undefined && (!Array.isArray(value) || value.length > 0)) return false;
  }
  const proxyRequests = state?.["eve.runtime.proxyInputRequests"];
  if (
    proxyRequests !== undefined &&
    (!isObject(proxyRequests) || Object.keys(proxyRequests).length > 0)
  )
    return false;
  return (
    (handles?.handles.length ?? 0) === 0 && tasks.every((task) => task.terminalView !== undefined)
  );
}
