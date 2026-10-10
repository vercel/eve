import type { SessionEvent } from "#protocol/session-event.js";

/**
 * Extracts the most recent structured result from a response's events: the value of its latest
 * `result` content part.
 */
export function extractCompletedResult<TOutput>(
  events: readonly SessionEvent[],
): TOutput | undefined {
  let result: TOutput | undefined;
  for (const event of events) {
    if (event.type === "content.completed" && event.data.kind === "result") {
      result = event.data.value as TOutput;
    }
  }
  return result;
}
