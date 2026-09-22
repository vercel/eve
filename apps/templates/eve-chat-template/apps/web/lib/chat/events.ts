import type { MessageStreamEvent } from "eve/client";

export function isChatTurnSettledEvent(event: MessageStreamEvent) {
  return (
    event.type === "authorization.required" ||
    event.type === "session.completed" ||
    event.type === "session.failed" ||
    event.type === "session.waiting"
  );
}
