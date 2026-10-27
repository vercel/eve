import type { DeliveryOutcome } from "#protocol/session-events/families/delivery.js";
import type { TurnOutcome } from "#protocol/session-events/families/turn.js";
import type { SessionOutcome } from "#protocol/session-events/families/session.js";
/** A settled delivery's result, separate from whether its session can accept more input. */
export type RequestStatus = "awaiting-input" | "completed" | "failed" | "cancelled";

/** Shared by complete views and response readers that joined a turn after its introduction. */
export function deliveryStatus(
  outcome: DeliveryOutcome | undefined,
  turn: TurnOutcome | undefined,
  session?: SessionOutcome,
): RequestStatus | "working" {
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
    default:
      return "failed";
  }
}
