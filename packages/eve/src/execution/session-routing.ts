import type { DeliverHookPayload, RuntimeActionResultHookPayload } from "#channel/types.js";
import { cancelAllIndexedSessionTasksStep } from "#execution/cancel-indexed-session-tasks-step.js";
import { reportDroppedWirePayloadStep } from "#execution/report-dropped-wire-payload-step.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import type { SessionBacklog } from "#execution/session-backlog.js";
import {
  isWorkflowMessage,
  type AuthorizationCallbackPayload,
  type SessionInboxPayload,
} from "#execution/session-inbox/inbox.js";
import {
  decodeSessionInboxPayload,
  SessionInboxPayloadError,
} from "#execution/session-inbox/protocol.js";
import type { SessionStateCursor } from "#execution/session-state-cursor.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { findRunningAgentHandle } from "#subagents/handles/query.js";
import { runProxySubagentEventStep } from "#subagents/event-proxy-step.js";

export interface TurnCancelRequest {
  readonly tasks?: boolean;
  readonly turnId?: string;
}

/** What one inbox payload asks of the session owner once decoded and applied. */
export type RoutedSessionPayload =
  | { readonly kind: "buffered"; readonly delivery: DeliverHookPayload }
  | { readonly kind: "cancel"; readonly request: TurnCancelRequest }
  | { readonly kind: "consumed" }
  | { readonly kind: "runtime-action-result"; readonly payload: RuntimeActionResultHookPayload }
  | { readonly kind: "workflow"; readonly message: WorkflowToolRunMessage }
  | { readonly kind: "authorization"; readonly payload: AuthorizationCallbackPayload };

/**
 * The one place session inbox payloads are decoded and applied to durable
 * state. Both the active turn and the parked wait call this; they differ only
 * in what they do with the result. Deliveries with descendant-bound content
 * are routed to children first; whatever remains is appended to the backlog.
 */
export async function routeSessionPayload(
  value: SessionInboxPayload,
  input: {
    readonly backlog: SessionBacklog;
    readonly cursor: SessionStateCursor;
    readonly routeDeliveries: boolean;
  },
): Promise<RoutedSessionPayload> {
  const { backlog, cursor } = input;
  if (value.kind === "runtime-action-result")
    return { kind: "runtime-action-result", payload: value };
  if (isWorkflowMessage(value)) return { kind: "workflow", message: value };
  if (value.kind === "authorization-callback") return { kind: "authorization", payload: value };
  if (value.kind === "subagent-input-request" || value.kind === "subagent-authorization-event") {
    const handle = findRunningAgentHandle(cursor.sessionState.snapshot.session.state, {
      callId: value.callId,
    });
    if (
      handle?.identity.name === value.subagentName &&
      handle.address.sessionId === value.childSessionId
    ) {
      await cursor.adopt(
        await runProxySubagentEventStep({
          hookPayload: value,
          parentWritable: cursor.parentWritable,
          serializedContext: cursor.serializedContext,
          sessionState: cursor.sessionState,
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
    // A lost delivery with an operator-visible signal is the designed
    // failure; reinterpreting an unknown payload is the bug.
    await reportDroppedWirePayloadStep({ detail: error.message, family: "session-inbox" });
    return { kind: "consumed" };
  }

  switch (command.kind) {
    case "deliver": {
      if (!backlog.accept(command)) return { kind: "consumed" };
      let delivery: DeliverHookPayload | undefined = command;
      if (input.routeDeliveries) {
        const routed = await routeDeliverToChildren({
          delivery,
          parentWritable: cursor.parentWritable,
          serializedContext: cursor.serializedContext,
          sessionState: cursor.sessionState,
        });
        await cursor.adopt(routed);
        if (routed.kind === "cancel-turn") return { kind: "cancel", request: {} };
        delivery = routed.remainder;
      }
      if (delivery === undefined) return { kind: "consumed" };
      backlog.deliveries.push(delivery);
      return { kind: "buffered", delivery };
    }
    case "clear":
    case "compact":
      backlog.controls.push(command.kind);
      return { kind: "consumed" };
    case "session-timeout":
      backlog.controls.push("expired");
      return { kind: "consumed" };
    case "reset":
      backlog.controls.push("reset");
      return { kind: "cancel", request: {} };
    case "cancel": {
      if (command.tasks === true) {
        await cancelAllIndexedSessionTasksStep({
          serializedContext: cursor.serializedContext,
          sessionState: cursor.sessionState,
        });
      }
      if (command.taskId !== undefined) backlog.discardTask(command.taskId);
      const request: TurnCancelRequest = { tasks: command.tasks };
      return {
        kind: "cancel",
        request: command.turnId === undefined ? request : { ...request, turnId: command.turnId },
      };
    }
  }
}
