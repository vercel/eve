import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { isCurrentTurnBoundaryEvent } from "#protocol/message.js";
import { openDevelopmentMessageStream } from "./live-stream.js";

/**
 * Reads newline-delimited message workflow events from the current response
 * body.
 *
 * Test-only helper.
 */
export async function readMessageStreamEvents(input: {
  onEvent?(event: HandleMessageStreamEvent): void;
  response: Response;
  startAfterBoundaryCount?: number;
  stopWhen?(event: HandleMessageStreamEvent): boolean;
}): Promise<HandleMessageStreamEvent[]> {
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
export function countCurrentTurnBoundaryEvents(
  events: readonly HandleMessageStreamEvent[],
): number {
  return events.filter(isCurrentTurnBoundaryEvent).length;
}

/**
 * Returns the last boundary event observed for the current streamed turn
 * slice.
 *
 * Test-only helper.
 */
export function extractCurrentTurnBoundaryEvent(
  events: readonly HandleMessageStreamEvent[],
): HandleMessageStreamEvent | undefined {
  return [...events].reverse().find(isCurrentTurnBoundaryEvent);
}
