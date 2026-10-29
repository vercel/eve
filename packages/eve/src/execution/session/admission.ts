import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import { settleDuplicateDeliveryStep } from "#execution/session/settle-duplicate-delivery-step.js";

import type {
  RuntimeActionResultHookPayload,
  SessionAuthContext,
  SessionControlIdentity,
} from "#channel/types.js";
import { controlDeliveryOf } from "#execution/session/control-delivery.js";
import type { ControlSettlement } from "#harness/facts.js";
import type {
  ControlOrigin,
  DeliveryAdmission,
  SessionInputQueue,
} from "#execution/session/input-queue.js";
import { isWorkflowMessage, type SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import {
  decodeSessionInboxPayload,
  SessionInboxPayloadError,
} from "#execution/session-inbox/protocol.js";
import { reportDroppedWirePayloadStep } from "#execution/report-dropped-wire-payload-step.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";

/** One canonical admission result, after wire decoding but before turn policy. */
type SessionAdmission =
  | { readonly admission: DeliveryAdmission; readonly kind: "delivery" }
  | { readonly kind: "cancel"; readonly origin?: ControlOrigin }
  | { readonly kind: "consumed" }
  /** A control this owner cannot run: settle it failed, so its sender doesn't wait forever. */
  | { readonly kind: "unsupported"; readonly settlement: ControlSettlement }
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
    readonly queue: SessionInputQueue;
    readonly cursor: SessionStateCursor;
  },
): Promise<SessionAdmission> {
  if (value.kind === "session-failure") throw new Error(value.error);
  if (value.kind === "runtime-action-result")
    return { kind: "runtime-action-result", payload: value };
  if (isWorkflowMessage(value)) return { kind: "workflow", message: value };
  if (value.kind === "authorization-callback") {
    input.queue.enqueueAuthorization(value.payloads);
    return { kind: "consumed" };
  }
  // A child's questions reach the session only through the run that opened it.
  if (value.kind === "subagent-interaction") {
    return { kind: "consumed" };
  }

  let command;
  try {
    command = decodeSessionInboxPayload(value);
  } catch (error) {
    if (!(error instanceof SessionInboxPayloadError)) throw error;
    await reportDroppedWirePayloadStep({ detail: error.message, family: "session-inbox" });
    const settlement = unsupportedControl(value, error.message);
    return settlement === undefined ? { kind: "consumed" } : { kind: "unsupported", settlement };
  }

  switch (command.kind) {
    case "session-prewarm":
      if (command.expectedOwnerRunId === getWorkflowMetadata().workflowRunId)
        input.queue.prepareOnDeployment(command.targetDeploymentId);
      return { kind: "consumed" };
    case "deliver": {
      const admission = input.queue.enqueueDelivery(command);
      if (admission === undefined) {
        await input.cursor.advance((state) =>
          settleDuplicateDeliveryStep({ ...state, delivery: command }),
        );
        return { kind: "consumed" };
      }
      return { admission, kind: "delivery" };
    }
    case "clear":
    case "compact":
      input.queue.enqueueControl(command.kind, controlOrigin(command));
      return { kind: "consumed" };
    case "session-timeout":
      // A previous owner's timer may fire after handoff; only this owner's deadline counts.
      if (command.ownerRunId === getWorkflowMetadata().workflowRunId) {
        input.queue.enqueueControl("expired");
      }
      return { kind: "consumed" };
    case "reset":
      input.queue.enqueueControl("reset", controlOrigin(command));
      return { kind: "cancel" };
    case "cancel": {
      const origin = controlOrigin(command);
      return origin === undefined ? { kind: "cancel" } : { kind: "cancel", origin };
    }
  }
}

/** The delivery a control arrived as. */
export function controlOrigin(command: SessionControlIdentity): ControlOrigin {
  return command.auth === undefined
    ? { deliveryId: command.deliveryId }
    : { auth: command.auth, deliveryId: command.deliveryId };
}

/**
 * The failed settlement of an undecodable payload that names its delivery: a control from a newer eve, or
 * a malformed one. Its sender awaits that delivery's settlement. Without a delivery id, nobody
 * waits on it, and the payload is only dropped.
 */
function unsupportedControl(
  value: SessionInboxPayload,
  reason: string,
): ControlSettlement | undefined {
  const { auth, deliveryId, kind } = value as Record<string, unknown>;
  if (typeof deliveryId !== "string" || deliveryId.length === 0) return undefined;
  const origin =
    typeof auth === "object" && auth !== null
      ? { auth: auth as SessionAuthContext, deliveryId }
      : { deliveryId };
  return {
    control: controlDeliveryOf(origin),
    outcome: "failed",
    reason,
    source: typeof kind === "string" && kind.length > 0 ? kind : "unknown",
  };
}
