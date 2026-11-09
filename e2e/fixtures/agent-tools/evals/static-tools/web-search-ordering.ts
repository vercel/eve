import type { SessionStreamEvent } from "eve/client";

export const WEB_SEARCH_TOOL_NAME = "web_search";

interface WebSearchEventOrder {
  readonly requestIndex: number;
  readonly resultIndex: number;
}

export function narratedWebSearchOrder(events: readonly SessionStreamEvent[]): boolean {
  const order = webSearchEventOrder(events);
  return (
    order !== undefined &&
    preToolNarrationExists(events, order.requestIndex) &&
    finalMessageFollowsResult(events, order.resultIndex)
  );
}

export function unNarratedWebSearchOrder(events: readonly SessionStreamEvent[]): boolean {
  const order = webSearchEventOrder(events);
  return (
    order !== undefined &&
    !preToolNarrationExists(events, order.requestIndex) &&
    finalMessageFollowsResult(events, order.resultIndex)
  );
}

function webSearchEventOrder(
  events: readonly SessionStreamEvent[],
): WebSearchEventOrder | undefined {
  const requests = events.flatMap((event, eventIndex) =>
    event.type === "call.requested" && event.data.capability.name === WEB_SEARCH_TOOL_NAME
      ? [{ callId: event.data.callId, eventIndex }]
      : [],
  );
  const callIds = new Set(requests.map((request) => request.callId));
  const results = events.flatMap((event, eventIndex) =>
    event.type === "call.settled" && callIds.has(event.data.callId)
      ? [{ callId: event.data.callId, eventIndex }]
      : [],
  );

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
  events: readonly SessionStreamEvent[],
  requestIndex: number,
): boolean {
  return events
    .slice(0, requestIndex)
    .some(
      (event) =>
        event.type === "content.completed" &&
        event.data.phase === "narration" &&
        String(event.data.value ?? "").trim().length > 0,
    );
}

function finalMessageFollowsResult(
  events: readonly SessionStreamEvent[],
  resultIndex: number,
): boolean {
  return events
    .slice(resultIndex + 1)
    .some((event) => event.type === "content.completed" && event.data.phase === "reply");
}
