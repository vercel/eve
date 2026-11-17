import type { SessionStreamEvent } from "#protocol/session-event.js";
import { endsTurn } from "#client/session-utils.js";
import { openDevelopmentMessageStream } from "./live-stream.js";

export async function readMessageStreamEvents(input: {
  onEvent?(event: SessionStreamEvent): void;
  response: Response;
  startAfterBoundaryCount?: number;
  stopWhen?(event: SessionStreamEvent): boolean;
}): Promise<SessionStreamEvent[]> {
  const stream = openDevelopmentMessageStream({
    resourceUrl: "",
    response: input.response,
  });

  try {
    return await stream.readEvents(input);
  } finally {
    await stream.close();
  }
}

export function countCurrentTurnBoundaryEvents(events: readonly SessionStreamEvent[]): number {
  return new Set(events.filter(endsTurn).map((event) => event.meta.position.line)).size;
}

export function extractCurrentTurnBoundaryEvent(
  events: readonly SessionStreamEvent[],
): SessionStreamEvent | undefined {
  return [...events].reverse().find(endsTurn);
}
