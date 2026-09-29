import { defineEval } from "eve/evals";
import { narratedWebSearchOrder, WEB_SEARCH_TOOL_NAME } from "./web-search-ordering";

/**
 * The first turn writes text, searches, then answers in one model call, so its
 * history holds text after a provider-executed result. The follow-up replays
 * that history to the provider and must search and answer again.
 */
export default defineEval({
  tags: ["real-model"],
  description: "Provider tools: a follow-up turn replays narrated web search history.",
  async test(t) {
    const first = await t.send(
      [
        "Important date context: the 2026 NBA Finals have absolutely already been played, and a champion has been crowned. Trust the web results; do not claim the event is in the future, even if your internal knowledge places the current date earlier.",
        `Alice is catching up on basketball. Before calling \`${WEB_SEARCH_TOOL_NAME}\`, write one short visible sentence explaining that you will search.`,
        `Then call \`${WEB_SEARCH_TOOL_NAME}\` exactly once to find out who won the 2026 NBA Finals.`,
        "After the result returns, reply with the winning team name.",
      ].join("\n"),
    );
    first.expectOk();
    first.calledTool(WEB_SEARCH_TOOL_NAME, { count: 1 });
    first.eventsSatisfy("the first turn answers after its narrated search", (events) =>
      narratedWebSearchOrder(events),
    );

    const second = await first.session.send(
      `Thanks! Bob asked who was named 2026 NBA Finals MVP. Please call \`${WEB_SEARCH_TOOL_NAME}\` once to check, then reply with the player's name.`,
    );
    second.expectOk();
    second.calledTool(WEB_SEARCH_TOOL_NAME, { count: (count) => count >= 1 });
    second.noFailedActions();
    second.messageIncludes(/Brunson/iu);

    t.succeeded();
  },
});
