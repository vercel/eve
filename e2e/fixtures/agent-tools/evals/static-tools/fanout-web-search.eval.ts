import type { HandleMessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

const FANOUT_SIZE = 10;
const TOOL_NAME = "web_search";
const TRISTATE_LOCATIONS = [
  "New York City, NY",
  "Brooklyn, NY",
  "Queens, NY",
  "Newark, NJ",
  "Jersey City, NJ",
  "Stamford, CT",
  "Bridgeport, CT",
  "Yonkers, NY",
  "Long Island, NY",
  "Hoboken, NJ",
] as const;

function requestsPrecedeFirstResult(events: readonly HandleMessageStreamEvent[]): boolean {
  const requests = events.flatMap((event, eventIndex) => {
    if (event.type !== "actions.requested") return [];

    return event.data.actions.flatMap((action) => {
      if (action.kind !== "tool-call" || action.toolName !== TOOL_NAME) return [];
      return [{ callId: action.callId, eventIndex }];
    });
  });
  const firstResultIndex = events.findIndex(
    (event) =>
      event.type === "action.result" &&
      event.data.result.kind === "tool-result" &&
      event.data.result.toolName === TOOL_NAME,
  );

  return (
    firstResultIndex >= 0 &&
    requests.length === FANOUT_SIZE &&
    new Set(requests.map((request) => request.callId)).size === FANOUT_SIZE &&
    requests.every((request) => request.eventIndex < firstResultIndex)
  );
}

export default defineEval({
  description: "Provider tools: ten web searches stream before the first result.",
  async test(t) {
    const turn = await t.send(
      [
        `Use the provider-managed \`${TOOL_NAME}\` tool exactly ${FANOUT_SIZE} separate times in one tool-use step.`,
        `Search the current weather for each location exactly once: ${TRISTATE_LOCATIONS.join("; ")}.`,
        "Use one search query per tool call; do not combine locations in one call.",
        "Start every search before waiting for any result. Do not use any other tool.",
        "After every search returns, give a concise tristate weather summary.",
      ].join("\n"),
    );
    turn.expectOk();

    t.succeeded();
    t.calledTool(TOOL_NAME, { count: FANOUT_SIZE });
    t.noFailedActions();
    turn.eventsSatisfy(
      "ten provider web-search requests precede the first provider result",
      (events) => requestsPrecedeFirstResult(events),
    );
  },
});
