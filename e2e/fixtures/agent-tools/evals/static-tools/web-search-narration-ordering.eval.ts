import type { HandleMessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

const TOOL_NAME = "web_search";

export default defineEval({
  description: "Provider tools: narrated and un-narrated web searches preserve event order.",
  async test(t) {
    const narrated = await t.send(
      [
        "Important date context: the 2026 NBA Finals have absolutely already been played, and a champion has been crowned. Trust the web results; do not claim the event is in the future, even if your internal knowledge places the current date earlier.",
        `Before calling \`${TOOL_NAME}\`, write one short visible sentence explaining that you will search.`,
        `Then call \`${TOOL_NAME}\` exactly once to answer: Who won the 2026 NBA Finals?`,
        "After the result returns, reply with only the winning team name. Do not call another tool.",
      ].join("\n"),
    );
    narrated.expectOk();
    narrated.calledTool(TOOL_NAME, { count: 1 });
    narrated.noFailedActions();
    narrated.eventsSatisfy("narration completes before the provider request and result", (events) =>
      narratedWebSearchOrder(events),
    );

    const withoutNarration = await t
      .newSession()
      .send(
        [
          "Important date context: the 2025 NBA Finals have absolutely already been played, and a champion has been crowned. Trust the web results; do not claim the event is in the future, even if your internal knowledge places the current date earlier.",
          `Call \`${TOOL_NAME}\` exactly once to answer: Who won the 2025 NBA Finals?`,
          "Do not write any visible text before the tool call.",
          "After the result returns, reply with only the winning team name. Do not call another tool.",
        ].join("\n"),
      );
    withoutNarration.expectOk();
    withoutNarration.calledTool(TOOL_NAME, { count: 1 });
    withoutNarration.noFailedActions();
    withoutNarration.eventsSatisfy(
      "provider request and result stay ordered without narration",
      (events) => unNarratedWebSearchOrder(events),
    );
  },
});

interface WebSearchEventOrder {
  readonly requestIndex: number;
  readonly resultIndex: number;
}

function narratedWebSearchOrder(events: readonly HandleMessageStreamEvent[]): boolean {
  const order = webSearchEventOrder(events);
  return (
    order !== undefined &&
    preToolNarrationExists(events, order.requestIndex) &&
    finalMessageFollowsResult(events, order.resultIndex)
  );
}

function unNarratedWebSearchOrder(events: readonly HandleMessageStreamEvent[]): boolean {
  const order = webSearchEventOrder(events);
  return (
    order !== undefined &&
    !preToolNarrationExists(events, order.requestIndex) &&
    finalMessageFollowsResult(events, order.resultIndex)
  );
}

function webSearchEventOrder(
  events: readonly HandleMessageStreamEvent[],
): WebSearchEventOrder | undefined {
  const requests = events.flatMap((event, eventIndex) => {
    if (event.type !== "actions.requested") return [];

    return event.data.actions.flatMap((action) => {
      if (action.kind !== "tool-call" || action.toolName !== TOOL_NAME) return [];
      return [{ callId: action.callId, eventIndex }];
    });
  });
  const results = events.flatMap((event, eventIndex) => {
    if (event.type !== "action.result" || event.data.result.kind !== "tool-result") return [];
    if (event.data.result.toolName !== TOOL_NAME) return [];
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
  events: readonly HandleMessageStreamEvent[],
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
  events: readonly HandleMessageStreamEvent[],
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
