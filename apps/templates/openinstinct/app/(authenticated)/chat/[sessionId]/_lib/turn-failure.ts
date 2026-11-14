import type { SessionStreamEvent } from "eve/client";
import type { ErrorInfo } from "eve/events";

export function getLatestTurnFailure(
  events: readonly SessionStreamEvent[]
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;

    if (event.type === "session.ended" && event.data.outcome === "failed") {
      return failureMessage(event.data.error);
    }
    if (event.type === "turn.settled") {
      return event.data.outcome === "failed"
        ? failureMessage(event.data.error)
        : undefined;
    }
    if (event.type === "delivery.consumed") return undefined;
  }
  return undefined;
}

function failureMessage(error: ErrorInfo | undefined) {
  if (error?.code === "MODEL_CALL_FAILED") {
    return "The model is temporarily unavailable. Please try again.";
  }
  return error?.message ?? "The request failed.";
}
