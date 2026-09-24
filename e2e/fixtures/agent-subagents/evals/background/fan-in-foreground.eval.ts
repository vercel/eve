import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { taskResultDeliveries, taskStarts } from "./helpers";

const REQUEST = [
  "Hi, this is Bob. I am choosing where to hold tomorrow's team offsite, Lisbon or Oslo,",
  "and I want the warmer city. Ask the forecaster about each city,",
  "then tell me which one will be warmer tomorrow and by how many degrees.",
].join(" ");

/**
 * Answers the user needs together stay in the foreground: both forecaster
 * calls are made in the same step without background, and the turn replies
 * with the comparison instead of a receipt.
 */
export default defineEval({
  description: "A request that needs two answers together keeps both agent calls waited.",
  tags: ["real-model"],
  timeoutMs: 240_000,
  async test(t) {
    const turn = await t.send(REQUEST);
    turn.expectOk();
    turn.calledSubagent("forecaster", { count: 2, status: "completed" });
    await t.require(
      taskStarts(turn.events, "forecaster"),
      satisfies(
        (calls: ReturnType<typeof taskStarts>) =>
          calls.length === 2 && calls.every((call) => call.mode === "foreground"),
        "both forecaster calls wait in the foreground",
      ),
    );
    turn
      .eventsSatisfy("both forecaster calls are requested in the same step", (events) =>
        events.some(
          (event) =>
            event.type === "actions.requested" &&
            event.data.actions.filter(
              (action) => "toolName" in action && action.toolName === "forecaster",
            ).length === 2,
        ),
      )
      .soft();
    t.check(
      taskResultDeliveries(turn.events),
      satisfies(
        (deliveries: readonly (readonly string[])[]) => deliveries.length === 0,
        "no answer arrives later as a task result",
      ),
    );
    turn.messageIncludes(/Lisbon/);
    t.judge(
      "The reply says Lisbon will be warmer than Oslo tomorrow, by about 15 °C (24 °C versus 9 °C).",
    ).gate(0.7);
    turn.noFailedActions();
  },
});
