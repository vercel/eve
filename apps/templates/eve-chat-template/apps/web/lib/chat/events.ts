import { isCurrentTurnBoundaryEvent, type MessageStreamEvent } from "eve/client";

export function isChatTurnSettledEvent(event: MessageStreamEvent) {
  return event.type === "authorization.required" || isCurrentTurnBoundaryEvent(event);
}
