import { type DurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { getAgentHandleStore } from "#subagents/handles/store.js";
import {
  readWorkflowTaskView,
  findBackgroundWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import { type TaskAuthorizationEventDelivery } from "#tasks/types.js";

/** Accepts authorization events from the workflow task itself or an agent it owns. */
export async function acceptTaskAuthorizationEventStep(input: {
  readonly delivery: TaskAuthorizationEventDelivery;
  readonly sessionState: DurableSessionState;
}): Promise<boolean> {
  "use step";

  const { hookPayload, taskId } = input.delivery;
  const durableSession = readDurableSession(input.sessionState);
  const entry = findBackgroundWorkflowToolRun(durableSession.state, taskId);
  if (entry === undefined) return false;

  // A workflow tool can request authorization without invoking a child agent.
  // It has no agent handle, so bind its sender to the recorded task run, tool,
  // and launching turn before accepting the event.
  if (
    entry.task.metadata.kind === "tool" &&
    entry.address.runId === hookPayload.childSessionId &&
    entry.task.metadata.name === hookPayload.subagentName &&
    entry.origin.turnId === hookPayload.event.data.turnId
  ) {
    const view = readWorkflowTaskView(entry.task);
    // Completion can arrive after the body has returned; its sign-in UI must still close.
    return hookPayload.event.type === "authorization.completed" || view === undefined;
  }

  const handles = getAgentHandleStore(durableSession.state)?.handles ?? [];
  const claimed = handles.find(
    (candidate) =>
      candidate.phase === "claimed" &&
      candidate.ownerId === taskId &&
      candidate.identity.name === hookPayload.subagentName &&
      candidate.address.sessionId === hookPayload.childSessionId,
  );
  // A just-started task child can emit authorization before the parent session
  // has processed the matching confirm command. Accept only an unambiguous
  // reservation; confirmed children still bind by child session id.
  const reserved = handles.filter(
    (candidate) =>
      candidate.phase === "reserved" &&
      candidate.ownerId === taskId &&
      candidate.identity.name === hookPayload.subagentName,
  );
  if (claimed === undefined && reserved.length !== 1) return false;

  const view = readWorkflowTaskView(entry.task);
  return view === undefined;
}
