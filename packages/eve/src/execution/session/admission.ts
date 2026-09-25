import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { RuntimeActionResultHookPayload, SessionCommand } from "#channel/types.js";
import { cancelAllIndexedSessionTasksStep } from "#execution/cancel-indexed-session-tasks-step.js";
import type { DeliveryAdmission, SessionInputQueue } from "#execution/session/input-queue.js";
import { isWorkflowMessage, type SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import {
  decodeSessionInboxPayload,
  SessionInboxPayloadError,
} from "#execution/session-inbox/protocol.js";
import { reportDroppedWirePayloadStep } from "#execution/report-dropped-wire-payload-step.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { findRunningAgentHandle } from "#subagents/handles/query.js";
import { runProxySubagentEventStep } from "#subagents/event-proxy-step.js";

export type SessionCancellation = Extract<SessionCommand, { readonly kind: "cancel" }>;

/** One canonical admission result, after wire decoding but before turn policy. */
export type SessionAdmission =
  | { readonly admission: DeliveryAdmission; readonly kind: "delivery" }
  | { readonly command: SessionCancellation; readonly kind: "cancel" }
  | { readonly kind: "consumed" }
  | { readonly kind: "runtime-action-result"; readonly payload: RuntimeActionResultHookPayload }
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
  if (value.kind === "subagent-input-request" || value.kind === "subagent-authorization-event") {
    const handle = findRunningAgentHandle(input.cursor.sessionState.snapshot.session.state, {
      callId: value.callId,
    });
    if (
      handle?.identity.name === value.subagentName &&
      handle.address.sessionId === value.childSessionId
    ) {
      await input.cursor.apply(
        await runProxySubagentEventStep({
          hookPayload: value,
          sessionWritable: input.cursor.sessionWritable,
          serializedContext: input.cursor.serializedContext,
          sessionState: input.cursor.sessionState,
        }),
      );
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
      const admission = input.queue.enqueueDelivery(
        command,
        input.cursor.sessionState.snapshot.session.state,
      );
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
      return { command, kind: "cancel" };
  }
}

/** Applies accepted cancellation effects after the active-turn guard passes. */
export async function applySessionCancellation(
  command: SessionCancellation,
  input: {
    readonly cursor: SessionStateCursor;
    readonly queue: SessionInputQueue;
  },
): Promise<void> {
  if (command.tasks === true) {
    const cancelled = await cancelAllIndexedSessionTasksStep({
      serializedContext: input.cursor.serializedContext,
      sessionState: input.cursor.sessionState,
    });
    await input.cursor.apply(cancelled);
    input.queue.discardStaleNotifications(input.cursor.sessionState.snapshot.session.state);
  }
  if (command.taskId !== undefined) input.queue.cancelTask(command.taskId);
}
