import type { HandleMessageStreamEvent, ResultCompletedStreamEvent } from "#protocol/message.js";

/**
 * Extracts the most recent finalized structured result from a turn event list.
 */
export function extractCompletedResult<TOutput>(
  events: readonly HandleMessageStreamEvent[],
): TOutput | undefined {
  let result: TOutput | undefined;

  for (const event of events) {
    if (isResultCompletedEvent(event)) {
      result = event.data.result as TOutput;
    }
  }

  return result;
}

function isResultCompletedEvent(
  event: HandleMessageStreamEvent,
): event is ResultCompletedStreamEvent {
  return event.type === "result.completed";
}
