import type { HandleMessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

const TOOL_NAME = "web_search";

function providerRequestsPrecedeResults(events: readonly HandleMessageStreamEvent[]): boolean {
  const requestIndexByCallId = new Map<string, number>();
  const resultIndexByCallId = new Map<string, number>();
  let requestCount = 0;
  let resultCount = 0;

  for (const [eventIndex, event] of events.entries()) {
    if (event.type === "actions.requested") {
      for (const action of event.data.actions) {
        if (action.kind !== "tool-call" || action.toolName !== TOOL_NAME) continue;
        requestCount += 1;
        requestIndexByCallId.set(action.callId, eventIndex);
      }
    }

    if (
      event.type === "action.result" &&
      event.data.result.kind === "tool-result" &&
      event.data.result.toolName === TOOL_NAME
    ) {
      resultCount += 1;
      resultIndexByCallId.set(event.data.result.callId, eventIndex);
    }
  }

  return (
    requestCount > 0 &&
    requestCount === requestIndexByCallId.size &&
    resultCount === resultIndexByCallId.size &&
    requestIndexByCallId.size === resultIndexByCallId.size &&
    [...requestIndexByCallId].every(([callId, requestIndex]) => {
      const resultIndex = resultIndexByCallId.get(callId);
      return resultIndex !== undefined && requestIndex < resultIndex;
    })
  );
}

export default defineEval({
  description: "Provider tools smoke: gateway web search answers a current-events question.",
  async test(t) {
    const turn = await t.send(
      [
        "Important date context: the 2026 NBA Finals have absolutely already been played, and a champion has been crowned.",
        "Do not claim the event is in the future, even if your internal knowledge incorrectly places the current date in 2025.",
        `Call ${TOOL_NAME} to verify who won the 2026 NBA Finals, then answer with the winning team.`,
      ].join("\n"),
    );

    t.succeeded();
    t.calledTool(TOOL_NAME);
    t.noFailedActions();
    turn.eventsSatisfy(
      "each provider web-search request is emitted once before its result",
      (events) => providerRequestsPrecedeResults(events),
    );
    t.messageIncludes(/New York Knicks/iu);
    t.judge.autoevals
      .factuality("The New York Knicks won the 2026 NBA Finals.", {
        on: turn.message,
      })
      .atLeast(0.5);
  },
});
