import { type DurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { readLatestTaskView } from "#execution/tasks/parent/run-parent.js";
import { getAgentHandleStore } from "#subagents/handles/store.js";
import { findSessionTaskEntry } from "#tasks/session-index.js";
import { isTerminalTaskStatus, type TaskAuthorizationEventDelivery } from "#tasks/types.js";

/** Accepts authorization events from the workflow task itself or an agent it owns. */
export async function acceptTaskAuthorizationEventStep(input: {
  readonly delivery: TaskAuthorizationEventDelivery;
  readonly sessionState: DurableSessionState;
}): Promise<boolean> {
  "use step";

  const { hookPayload, taskId } = input.delivery;
  const durableSession = await readDurableSession(input.sessionState);
  const entry = findSessionTaskEntry(durableSession.state, taskId);
  if (entry === undefined) return false;

  // A workflow tool can request authorization without invoking a child agent.
  // It has no agent handle, so bind its sender to the recorded task run, tool,
  // and launching turn before accepting the event.
  if (
    entry.metadata.kind === "tool" &&
    entry.taskRunId === hookPayload.childSessionId &&
    entry.metadata.name === hookPayload.subagentName &&
    entry.createdByTurnId === hookPayload.event.data.turnId
  ) {
    const view = await readLatestTaskView({ taskRunId: entry.taskRunId });
    // Completion can arrive after the body has returned; its sign-in UI must still close.
    return (
      view !== undefined &&
      (hookPayload.event.type === "authorization.completed" || !isTerminalTaskStatus(view.status))
    );
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

  const view = await readLatestTaskView({ taskRunId: entry.taskRunId });
  return view !== undefined && !isTerminalTaskStatus(view.status);
}
