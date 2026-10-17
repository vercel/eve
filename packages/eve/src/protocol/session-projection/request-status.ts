import type { DeliveryOutcome } from "#protocol/session-events/families/delivery.js";
import type { TurnOutcome } from "#protocol/session-events/families/turn.js";
import type { SessionOutcome } from "#protocol/session-events/families/session.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

/** The state of one request, separate from whether its session has ended. */
export type RequestStatus = "working" | "awaiting-input" | "completed" | "failed" | "cancelled";

/** The request's own settlement, not the session's readiness for another message. */
export function requestStatus(view: SessionView, deliveryId: string): RequestStatus {
  const delivery = view.deliveries[deliveryId];
  return deliveryStatus(
    delivery?.outcome,
    delivery?.turnId === undefined ? undefined : view.turns[delivery.turnId]?.outcome,
    delivery === undefined ? undefined : view.session.outcome,
  );
}

/** Shared by complete views and response readers that joined a turn after its introduction. */
export function deliveryStatus(
  outcome: DeliveryOutcome | undefined,
  turn: TurnOutcome | undefined,
  session?: SessionOutcome,
): RequestStatus {
  switch (outcome) {
    case undefined:
      return session === "failed" ? "failed" : "working";
    case "awaiting-input":
      return "awaiting-input";
    case "failed":
    case "refused":
      return "failed";
    case "ignored":
    case "applied":
      return "completed";
    case "handled":
      return turn === "cancelled" ? "cancelled" : turn === "failed" ? "failed" : "completed";
  }
}
