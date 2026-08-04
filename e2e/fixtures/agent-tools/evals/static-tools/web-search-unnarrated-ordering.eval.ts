import { defineEval } from "eve/evals";
import { unNarratedWebSearchOrder, WEB_SEARCH_TOOL_NAME } from "./web-search-ordering";

export default defineEval({
  tags: ["real-model"],
  description: "Provider tools: un-narrated web searches preserve event order.",
  async test(t) {
    const turn = await t.send({
      message: [
        "Important date context: the 2025 NBA Finals have absolutely already been played, and a champion has been crowned. Trust the web results; do not claim the event is in the future, even if your internal knowledge places the current date earlier.",
        `Call \`${WEB_SEARCH_TOOL_NAME}\` exactly once to answer: Who won the 2025 NBA Finals?`,
        "Do not write any visible text before the tool call.",
        "After the result returns, reply with only the winning team name. Do not call another tool.",
      ].join("\n"),
    });

    turn.expectOk();
    turn.calledTool(WEB_SEARCH_TOOL_NAME, { count: 1 });
    turn.noFailedActions();
    turn.eventsSatisfy("provider request and result stay ordered without narration", (events) =>
      unNarratedWebSearchOrder(events),
    );
  },
});
