import { type DurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { getAgentHandleStore } from "#subagents/handles/store.js";
import { getBackgroundTasks } from "#harness/workflow-tool-runs.js";
import { type TaskAuthorizationEventDelivery } from "#tasks/types.js";

/** Accepts authorization events from the workflow task itself or an agent it owns. */
export async function acceptTaskAuthorizationEventStep(input: {
  readonly delivery: TaskAuthorizationEventDelivery;
  readonly sessionState: DurableSessionState;
}): Promise<boolean> {
  "use step";

  const { hookPayload, taskId } = input.delivery;
  const durableSession = readDurableSession(input.sessionState);
  const task = getBackgroundTasks(durableSession.state).get(taskId);
  if (task === undefined) return false;

  // A workflow tool can request authorization without invoking a child agent.
  // It has no agent handle, so bind its sender to the recorded task run, tool,
  // and launching turn before accepting the event.
  if (
    task.metadata.kind === "tool" &&
    task.run.address.runId === hookPayload.childSessionId &&
    task.metadata.name === hookPayload.subagentName &&
    task.turnId === hookPayload.event.data.turnId
  ) {
    // Completion can arrive after the body has returned; its sign-in UI must still close.
    return hookPayload.event.type === "authorization.completed" || task.status === "working";
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

  return task.status === "working";
}
