import type { HandleMessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

const TOOL_NAME = "web_search";
const MIN_COMPLETED_SEARCHES = 10;

const EXPECTED_WINNERS =
  "2026 New York Knicks; 2025 Oklahoma City Thunder; 2024 Boston Celtics; " +
  "2023 Denver Nuggets; 2022 Golden State Warriors; 2021 Milwaukee Bucks; " +
  "2020 Los Angeles Lakers; 2019 Toronto Raptors; 2018 Golden State Warriors; " +
  "2017 Golden State Warriors.";

function completedToolResultCount(events: readonly HandleMessageStreamEvent[], toolName: string) {
  const callIds = new Set<string>();
  for (const event of events) {
    if (
      event.type === "action.result" &&
      event.data.status === "completed" &&
      event.data.result.kind === "tool-result" &&
      event.data.result.toolName === toolName
    ) {
      callIds.add(event.data.result.callId);
    }
  }
  return callIds.size;
}

export default defineEval({
  description: "Provider tools smoke: ten parallel gateway web searches complete successfully.",
  async test(t) {
    const turn = await t.send(
      [
        "Important date context: the 2026 NBA Finals have absolutely already been played, and a champion has been crowned.",
        "Do not claim any of these seasons are in the future or unresolved, even if your internal knowledge incorrectly places the current date earlier; trust the web results.",
        "Using 10 parallel web_search calls: lookup the nba finals winner from 2026 back to 2017.",
      ].join("\n"),
    );

    t.succeeded();
    turn.eventsSatisfy(
      "at least ten completed web_search calls",
      (events) => completedToolResultCount(events, TOOL_NAME) >= MIN_COMPLETED_SEARCHES,
    );
    t.noFailedActions();
    t.judge.autoevals.factuality(EXPECTED_WINNERS, { on: turn.message }).atLeast(0.5);
  },
});
