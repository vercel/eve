import type { HandleMessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

const TOOL_NAME = "web_search";
const SEARCH_COUNT = 10;
const QUERIES = [
  "web search fanout probe 01",
  "web search fanout probe 02",
  "web search fanout probe 03",
  "web search fanout probe 04",
  "web search fanout probe 05",
  "web search fanout probe 06",
  "web search fanout probe 07",
  "web search fanout probe 08",
  "web search fanout probe 09",
  "web search fanout probe 10",
] as const;

function completedDistinctCalls(events: readonly HandleMessageStreamEvent[]): number {
  const callIds = new Set<string>();
  for (const event of events) {
    if (
      event.type === "action.result" &&
      event.data.status === "completed" &&
      event.data.result.kind === "tool-result" &&
      event.data.result.toolName === TOOL_NAME
    ) {
      callIds.add(event.data.result.callId);
    }
  }
  return callIds.size;
}

export default defineEval({
  description: "Provider tools smoke: ten Exa web searches complete in a single turn.",
  async test(t) {
    const turn = await t.send(
      [
        `Call the \`${TOOL_NAME}\` tool exactly ${SEARCH_COUNT} separate times.`,
        `Use each query exactly once: ${QUERIES.map((query) => `"${query}"`).join(", ")}.`,
        "Do not use any other tool.",
        "After every call returns, reply with exactly: web search fanout complete",
      ].join("\n"),
    );
    turn.expectOk();

    t.succeeded();
    t.calledTool(TOOL_NAME, { count: (count) => count >= SEARCH_COUNT });
    t.noFailedActions();
    turn.eventsSatisfy(
      "ten distinct web_search calls complete",
      (events) => completedDistinctCalls(events) >= SEARCH_COUNT,
    );
    t.messageIncludes(/web search fanout complete/iu);
  },
});
