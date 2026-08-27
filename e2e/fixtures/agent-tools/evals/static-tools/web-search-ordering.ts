import type { MessageStreamEvent } from "eve/client";

export const WEB_SEARCH_TOOL_NAME = "web_search";

interface WebSearchEventOrder {
  readonly requestIndex: number;
  readonly resultIndex: number;
}

export function narratedWebSearchOrder(events: readonly MessageStreamEvent[]): boolean {
  const order = webSearchEventOrder(events);
  return (
    order !== undefined &&
    preToolNarrationExists(events, order.requestIndex) &&
    finalMessageFollowsResult(events, order.resultIndex)
  );
}

export function unNarratedWebSearchOrder(events: readonly MessageStreamEvent[]): boolean {
  const order = webSearchEventOrder(events);
  return (
    order !== undefined &&
    !preToolNarrationExists(events, order.requestIndex) &&
    finalMessageFollowsResult(events, order.resultIndex)
  );
}

function webSearchEventOrder(
  events: readonly MessageStreamEvent[],
): WebSearchEventOrder | undefined {
  const requests = events.flatMap((event, eventIndex) => {
    if (event.type !== "actions.requested") return [];

    return event.data.actions.flatMap((action) => {
      if (action.kind !== "tool-call" || action.toolName !== WEB_SEARCH_TOOL_NAME) return [];
      return [{ callId: action.callId, eventIndex }];
    });
  });
  const results = events.flatMap((event, eventIndex) => {
    if (event.type !== "action.result" || event.data.result.kind !== "tool-result") return [];
    if (event.data.result.toolName !== WEB_SEARCH_TOOL_NAME) return [];
    return [{ callId: event.data.result.callId, eventIndex }];
  });

  const [request] = requests;
  const [result] = results;
  if (
    request === undefined ||
    result === undefined ||
    requests.length !== 1 ||
    results.length !== 1 ||
    request.callId !== result.callId ||
    request.eventIndex >= result.eventIndex
  ) {
    return undefined;
  }
  return { requestIndex: request.eventIndex, resultIndex: result.eventIndex };
}

function preToolNarrationExists(
  events: readonly MessageStreamEvent[],
  requestIndex: number,
): boolean {
  return events
    .slice(0, requestIndex)
    .some(
      (event) =>
        event.type === "message.completed" &&
        event.data.finishReason === "tool-calls" &&
        event.data.message !== null &&
        event.data.message.trim().length > 0,
    );
}

function finalMessageFollowsResult(
  events: readonly MessageStreamEvent[],
  resultIndex: number,
): boolean {
  return events
    .slice(resultIndex + 1)
    .some(
      (event) =>
        event.type === "message.completed" &&
        event.data.finishReason !== "tool-calls" &&
        event.data.message !== null,
    );
}
