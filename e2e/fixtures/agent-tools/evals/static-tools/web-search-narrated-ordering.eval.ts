import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { narratedWebSearchOrder, WEB_SEARCH_TOOL_NAME } from "./web-search-ordering";

export default defineEval({
  tags: ["real-model"],
  description:
    "A narrated web search answers the question with exactly one ordered request/result pair.",
  async test(t) {
    const turn = await t.send(
      [
        "Important date context: the 2026 NBA Finals have absolutely already been played, and a champion has been crowned. Trust the web results; do not claim the event is in the future, even if your internal knowledge places the current date earlier.",
        `Before calling \`${WEB_SEARCH_TOOL_NAME}\`, write one short visible sentence explaining that you will search.`,
        `Then call \`${WEB_SEARCH_TOOL_NAME}\` exactly once to answer: Who won the 2026 NBA Finals?`,
        "After the result returns, reply with only the full winning team name. Do not call another tool.",
      ].join("\n"),
    );

    turn.expectOk();
    turn.calledTool(WEB_SEARCH_TOOL_NAME, { count: 1 });
    turn.noFailedActions();
    // The helper counts raw requests/results and matches their call IDs,
    // so a duplicate delivery cannot hide behind logical tool-call counts.
    turn.eventsSatisfy(
      "one matching request/result pair follows narration and precedes the reply",
      (events) => narratedWebSearchOrder(events),
    );
    await t.require(
      turn.message,
      satisfies(
        (message) => typeof message === "string" && /New York Knicks/iu.test(message),
        "the final answer names the winning team",
      ),
    );
    t.succeeded();
  },
});
