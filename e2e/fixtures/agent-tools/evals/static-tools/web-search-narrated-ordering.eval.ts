import { defineEval } from "eve/evals";
import { narratedWebSearchOrder, WEB_SEARCH_TOOL_NAME } from "./web-search-ordering";

export default defineEval({
  tags: ["real-model"],
  description: "Provider tools: narrated web searches preserve event order.",
  async test(t) {
    const turn = await t.send({
      message: [
        "Important date context: the 2026 NBA Finals have absolutely already been played, and a champion has been crowned. Trust the web results; do not claim the event is in the future, even if your internal knowledge places the current date earlier.",
        `Before calling \`${WEB_SEARCH_TOOL_NAME}\`, write one short visible sentence explaining that you will search.`,
        `Then call \`${WEB_SEARCH_TOOL_NAME}\` exactly once to answer: Who won the 2026 NBA Finals?`,
        "After the result returns, reply with only the winning team name. Do not call another tool.",
      ].join("\n"),
    });

    turn.expectOk();
    turn.calledTool(WEB_SEARCH_TOOL_NAME, { count: 1 });
    turn.noFailedActions();
    turn.eventsSatisfy("narration completes before the provider request and result", (events) =>
      narratedWebSearchOrder(events),
    );
  },
});
