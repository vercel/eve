import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type {
  RuntimeActionResultHookPayload,
  SessionCommand,
  TaskStartedHookPayload,
} from "#channel/types.js";
import type { DeliveryAdmission, SessionInputQueue } from "#execution/session/input-queue.js";
import { isWorkflowMessage, type SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import {
  decodeSessionInboxPayload,
  SessionInboxPayloadError,
} from "#execution/session-inbox/protocol.js";
import { reportDroppedWirePayloadStep } from "#execution/report-dropped-wire-payload-step.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { cancelTasks } from "#tasks/owner-body.js";
import type { TaskDeadlineSignal } from "#tasks/protocol.js";
import { getTaskTable } from "#tasks/state.js";
import { runProxySubagentEventStep } from "#subagents/event-proxy-step.js";
import { flushUnsentCallerEvents } from "#subagents/remote/unsent-caller-events.js";

export type SessionCancellation = Extract<SessionCommand, { readonly kind: "cancel" }>;

/** One canonical admission result, after wire decoding but before turn policy. */
export type SessionAdmission =
  | { readonly admission: DeliveryAdmission; readonly kind: "delivery" }
  | { readonly command: SessionCancellation; readonly kind: "cancel" }
  | { readonly kind: "consumed" }
  | { readonly kind: "runtime-action-result"; readonly payload: RuntimeActionResultHookPayload }
  | { readonly kind: "task-report"; readonly payload: TaskStartedHookPayload }
  | { readonly kind: "task-deadline"; readonly signal: TaskDeadlineSignal }
  | { readonly kind: "workflow"; readonly message: WorkflowToolRunMessage };

/**
 * Decodes and admits one inbox payload. This boundary never decides whether a
 * delivery steers, starts a turn, or routes to a child; those are selection
 * and delivery-routing policies owned by their respective layers.
 */
export async function admitSessionInboxPayload(
  value: SessionInboxPayload,
  input: {
    readonly cursor: SessionStateCursor;
    readonly queue: SessionInputQueue;
  },
): Promise<SessionAdmission> {
  if (value.kind === "runtime-action-result")
    return { kind: "runtime-action-result", payload: value };
  if (isWorkflowMessage(value)) return { kind: "workflow", message: value };
  if (value.kind === "authorization-callback") {
    input.queue.enqueueAuthorization(value.payloads);
    return { kind: "consumed" };
  }
  if (value.kind === "task.started") return { kind: "task-report", payload: value };
  if (value.kind === "task.deadline") return { kind: "task-deadline", signal: value };
  if (value.kind === "subagent-input-request" || value.kind === "subagent-authorization-event") {
    const task = getTaskTable(input.cursor.sessionState.snapshot.session).records.find(
      (record) =>
        record.callId === value.callId &&
        (record.status === "working" || record.status === "input_required"),
    );
    // A remote child reports only through the callback route, which marks its
    // payloads; it may speak only for the remote session the owner started.
    const fromChild =
      value.source?.kind === "remote"
        ? task?.child?.kind === "remote" && task.child.sessionId === value.childSessionId
        : task?.child === undefined ||
          (task.child.kind === "local" && task.child.sessionId === value.childSessionId);
    if (task?.name === value.subagentName && fromChild) {
      await input.cursor.apply(
        await runProxySubagentEventStep({
          hookPayload: value,
          sessionWritable: input.cursor.sessionWritable,
          serializedContext: input.cursor.serializedContext,
          sessionState: input.cursor.sessionState,
          taskId: task.id,
        }),
      );
      // A descendant's question this session passes up must not wait for its next input.
      await flushUnsentCallerEvents(input.cursor);
    }
    return { kind: "consumed" };
  }

  let command;
  try {
    command = decodeSessionInboxPayload(value);
  } catch (error) {
    if (!(error instanceof SessionInboxPayloadError)) throw error;
    await reportDroppedWirePayloadStep({ detail: error.message, family: "session-inbox" });
    return { kind: "consumed" };
  }

  switch (command.kind) {
    case "deliver": {
      const admission = input.queue.enqueueDelivery(command);
      return admission === undefined ? { kind: "consumed" } : { admission, kind: "delivery" };
    }
    case "clear":
    case "compact":
      input.queue.enqueueControl(command.kind);
      return { kind: "consumed" };
    case "session-timeout":
      // A previous owner's timer may fire after handoff; only this owner's deadline counts.
      if (command.ownerRunId === getWorkflowMetadata().workflowRunId) {
        input.queue.enqueueControl("expired");
      }
      return { kind: "consumed" };
    case "reset":
      input.queue.enqueueControl("reset");
      return { command: { kind: "cancel" }, kind: "cancel" };
    case "cancel":
      // Task cancellation applies on admission, whether a turn is running,
      // parked, or the session is idle, and never waits for a child to stop.
      if (command.taskId !== undefined) {
        await cancelTasks(input.cursor, { kind: "task", taskId: command.taskId });
        return { kind: "consumed" };
      }
      // The turn's own calls are cancelled with the turn, when the turn guard matches.
      if (command.tasks === true) await cancelTasks(input.cursor, { kind: "background" });
      return { command, kind: "cancel" };
  }
}
