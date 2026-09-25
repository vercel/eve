import type { MessageResponse } from "../../src/client/message-response.js";
import { summarizeTurnEvents } from "../../src/client/session-utils.js";
import { isCurrentTurnBoundaryEvent, type MessageStreamEvent } from "../../src/protocol/message.js";

/**
 * Reads a message's response through its first boundary, a held turn's
 * waiting boundary included, then stops reading. `result()` instead follows a
 * held turn to its end; these scenarios observe the turn up to the point a
 * person could write again.
 */
export async function throughFirstBoundary(response: MessageResponse): Promise<{
  readonly events: MessageStreamEvent[];
  readonly message: string | undefined;
}> {
  const events: MessageStreamEvent[] = [];
  for await (const event of response) {
    events.push(event);
    if (isCurrentTurnBoundaryEvent(event)) break;
  }
  return { events, message: summarizeTurnEvents(events).message };
}
