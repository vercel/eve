import { defineEval } from "eve/evals";

import { firstRequestOf, firstSettlementOf, taskStarts } from "./task-events";

const SUMMARY = "Version 4.2 adds the new export dialog and fixes two calendar sync bugs.";

/**
 * Publishing depends on the review, so the model waits for the reviewer's
 * result before it calls `publish_summary`.
 */
export default defineEval({
  description: "The model doesn't use a side-effect tool before the result it depends on.",
  tags: ["real-model"],
  async test(t) {
    const turn = await t.send(
      `Alice drafted this release summary: "${SUMMARY}" Please ask the reviewer to check it, and publish it with publish_summary only if the reviewer approves.`,
    );
    turn.expectOk();

    t.calledSubagent("reviewer", { count: 1, status: "completed" });
    turn.calledTool("publish_summary", { count: 1 });
    turn.eventsSatisfy("publishing waits for the review's result", (events) => {
      const reviewCallIds = taskStarts(events, "reviewer").map((call) => call.callId);
      const reviewed = firstSettlementOf(events, reviewCallIds);
      const published = firstRequestOf(events, "publish_summary");
      return reviewed >= 0 && published > reviewed;
    });
    t.noFailedActions();
  },
});
