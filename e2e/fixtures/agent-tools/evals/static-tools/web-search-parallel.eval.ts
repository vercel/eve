import type { MessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

const TOOL_NAME = "web_search";
const MIN_COMPLETED_SEARCHES = 8;

const EXPECTED_WINNERS = [
  /Knicks/iu,
  /Thunder/iu,
  /Celtics/iu,
  /Nuggets/iu,
  /Warriors/iu,
  /Bucks/iu,
  /Lakers/iu,
  /Raptors/iu,
];

function completedToolResultCount(events: readonly MessageStreamEvent[], toolName: string) {
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
  tags: ["real-model"],
  description: "Provider tools smoke: eight parallel gateway web searches complete successfully.",
  async test(t) {
    const turn = await t.send(
      [
        "Important date context: the 2026 NBA Finals have absolutely already been played, and a champion has been crowned.",
        "Do not claim any of these seasons are in the future or unresolved, even if your internal knowledge incorrectly places the current date earlier; trust the web results.",
        "Using 8 parallel web_search calls: lookup the nba finals winner from 2026 back to 2019.",
      ].join("\n"),
    );

    t.succeeded();
    turn.eventsSatisfy(
      "at least eight completed web_search calls",
      (events) => completedToolResultCount(events, TOOL_NAME) >= MIN_COMPLETED_SEARCHES,
    );
    t.noFailedActions();
    for (const winner of EXPECTED_WINNERS) {
      turn.messageIncludes(winner);
    }
  },
});
