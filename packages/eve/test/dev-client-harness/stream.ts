import type { SessionStreamEvent } from "#protocol/session-event.js";
import { endsTurn } from "#client/session-utils.js";
import { openDevelopmentMessageStream } from "./live-stream.js";

/**
 * Reads newline-delimited message workflow events from the current response
 * body.
 *
 * Test-only helper.
 */
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

/**
 * Counts boundary events in one stream slice.
 *
 * Test-only helper.
 */
export function countCurrentTurnBoundaryEvents(events: readonly SessionStreamEvent[]): number {
  return new Set(events.filter(endsTurn).map((event) => event.meta.position.line)).size;
}

/**
 * Returns the last boundary event observed for the current streamed turn
 * slice.
 *
 * Test-only helper.
 */
export function extractCurrentTurnBoundaryEvent(
  events: readonly SessionStreamEvent[],
): SessionStreamEvent | undefined {
  return [...events].reverse().find(endsTurn);
}
