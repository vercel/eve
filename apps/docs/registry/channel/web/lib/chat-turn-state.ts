import type { MessageStreamEvent } from "eve/client";

// An attached session stream also carries background-task notifications. Only
// parent turn boundaries determine whether the composer should offer Stop.
export function getActiveChatTurn(events: readonly MessageStreamEvent[]): string | undefined {
  const finished = new Set<string>();
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    switch (event.type) {
      case "session.waiting":
      case "session.completed":
      case "session.failed":
        return undefined;
      case "turn.completed":
      case "turn.cancelled":
      case "turn.failed":
        finished.add(event.data.turnId);
        break;
      case "turn.started":
        if (!finished.has(event.data.turnId)) return event.data.turnId;
        break;
    }
  }
  return undefined;
}
