import type { SessionControlIdentity } from "#channel/types.js";
import type { ControlOrigin } from "#execution/session/scheduler/held.js";
import { isSteeringMessage } from "#execution/session/scheduler/held.js";
import type { Arrival } from "#execution/session/scheduler/events.js";
import type { Turn } from "#execution/session/scheduler/state.js";
import { isWorkflowMessage, type SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import {
  decodeSessionInboxPayload,
  SessionInboxPayloadError,
} from "#execution/session-inbox/protocol.js";

/**
 * What an inbox payload brings the scheduler, after wire decoding. Reading never decides whether
 * a delivery steers, starts a turn, or routes to a child: the scheduler does. `ownerRunId` names
 * this owner's run: a previous owner's session timeout may fire after a handoff, and only this
 * owner's deadline counts.
 */
export function arrivalsOf(
  payload: SessionInboxPayload,
  ownerRunId: string | undefined,
): readonly Arrival[] {
  if (payload.kind === "session-failure") throw new Error(payload.error);
  if (payload.kind === "runtime-action-result")
    return [{ kind: "results", results: payload.results }];
  if (isWorkflowMessage(payload)) return [{ kind: "run", message: payload }];
  if (payload.kind === "authorization-callback")
    return [{ kind: "sign-ins", payloads: payload.payloads }];
  // A child's questions reach the session only through the run that opened it.
  if (payload.kind === "subagent-interaction") return [{ kind: "ignored" }];

  let command;
  try {
    command = decodeSessionInboxPayload(payload);
  } catch (error) {
    if (!(error instanceof SessionInboxPayloadError)) throw error;
    return [{ detail: error.message, kind: "dropped" }];
  }
  switch (command.kind) {
    case "deliver":
      return [{ delivery: command, kind: "delivery" }];
    case "clear":
    case "compact":
      return [{ control: command.kind, kind: "control", origin: controlOrigin(command) }];
    case "session-prewarm":
      return command.expectedOwnerRunId === ownerRunId
        ? [{ kind: "prewarm", targetDeploymentId: command.targetDeploymentId }]
        : [{ kind: "ignored" }];
    case "session-timeout":
      return command.ownerRunId === ownerRunId
        ? [{ control: "expired", kind: "control" }]
        : [{ kind: "ignored" }];
    case "reset":
      // A reset ends the session once its turn stops: it names no turn, so it stops whichever runs.
      return [
        { control: "reset", kind: "control", origin: controlOrigin(command) },
        { kind: "cancel" },
      ];
    case "cancel":
      return [
        {
          kind: "cancel",
          origin: controlOrigin(command),
          ...(command.turnId !== undefined && { turnId: command.turnId }),
        },
      ];
  }
}

/**
 * What a payload does the moment it arrives, before the turn reads it in order: a cancel of this
 * turn, or a session failure, stops the step that runs, and the turn's own person's message
 * interrupts generation, so the step reads it. Neither changes what the scheduler holds: the
 * payload stays in the inbox, and the turn admits it at its next boundary.
 */
export function urgency(
  payload: SessionInboxPayload,
  turn: Pick<Turn, "control" | "steerer" | "turnId">,
  options: {
    /** A child waits on answers: a message might be one, so it doesn't interrupt. */
    readonly childrenAsk: boolean;
    readonly admittedDeliveryKeys?: readonly string[];
  },
): "stop" | "interrupt" | undefined {
  if (payload.kind === "session-failure") return "stop";
  let arrivals: readonly Arrival[];
  try {
    arrivals = arrivalsOf(payload, undefined);
  } catch {
    return undefined;
  }
  for (const arrival of arrivals) {
    if (
      arrival.kind === "cancel" &&
      turn.control !== true &&
      (arrival.turnId === undefined || arrival.turnId === turn.turnId)
    )
      return "stop";
    if (
      arrival.kind === "delivery" &&
      !(
        arrival.delivery.idempotencyKey !== undefined &&
        options.admittedDeliveryKeys?.includes(arrival.delivery.idempotencyKey)
      ) &&
      !options.childrenAsk &&
      isSteeringMessage(arrival.delivery, turn.steerer)
    )
      return "interrupt";
  }
  return undefined;
}

/** The delivery a control arrived as. */
export function controlOrigin(command: SessionControlIdentity): ControlOrigin {
  return command.auth === undefined
    ? { deliveryId: command.deliveryId }
    : { auth: command.auth, deliveryId: command.deliveryId };
}
