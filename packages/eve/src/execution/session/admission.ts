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
import { surfaceTaskInput } from "#tasks/owner-body.js";
import type { TaskDeadlineSignal } from "#tasks/protocol.js";
import { childCallId } from "#tasks/record.js";
import { getTaskTable } from "#tasks/state.js";

export type SessionCancellation = Extract<SessionCommand, { readonly kind: "cancel" }>;

/** One canonical admission result, after wire decoding but before turn policy. */
export type SessionAdmission =
  | { readonly admission: DeliveryAdmission; readonly kind: "delivery" }
  /**
   * A cancel, or a reset or this owner's session expiry, each of which also
   * stops the active turn; a reset or expiry queued its control as well.
   */
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
  if (value.kind === "task.input") {
    const task = getTaskTable(input.cursor.sessionState.snapshot.session).records.find(
      (record) =>
        childCallId(record) === value.callId &&
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
      await surfaceTaskInput(input.cursor, task.id, value.event);
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
      if (command.ownerRunId !== getWorkflowMetadata().workflowRunId) return { kind: "consumed" };
      input.queue.enqueueControl("expired");
      return { command: { kind: "cancel" }, kind: "cancel" };
    case "reset":
      input.queue.enqueueControl("reset");
      return { command: { kind: "cancel" }, kind: "cancel" };
    case "cancel":
      return { command, kind: "cancel" };
  }
}
