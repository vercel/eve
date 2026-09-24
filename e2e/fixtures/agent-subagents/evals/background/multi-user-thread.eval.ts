import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { taskResultDeliveries, taskStarts, watchNextTurn } from "./helpers";

const BOB_AUTHORIZATION = "Bearer e2e-workspace-label-bob";
const ALICE_REQUEST = [
  "Hi, this is Alice. I am choosing where to hold tomorrow's team offsite, Lisbon or Oslo.",
  "Ask the forecaster about each city, then tell me which one will be warmer tomorrow.",
].join(" ");
const BOB_NOTE = [
  "Hi, Bob here, joining the thread with a quick note for everyone:",
  "the team lunch today moved from noon to 1 pm.",
].join(" ");

/**
 * A shared thread where Bob posts an unrelated note while Alice's two
 * forecast lookups run. The note moves the lookups to the background as one
 * group, so Alice still gets one combined answer instead of one post per
 * lookup, and nothing is delegated twice.
 */
export default defineEval({
  description:
    "An unrelated message in a shared thread does not fragment another user's request into several posts.",
  tags: ["real-model"],
  timeoutMs: 300_000,
  async test(t) {
    const conversation = await t.session();
    const live = await conversation.start(ALICE_REQUEST);
    await live.waitForEvent("task.started", { data: { name: "forecaster" } });
    // Give the second lookup a moment to start; both are requested in one step.
    for (let waited = 0; waited < 20_000; waited += 250) {
      if (taskStarts(live.events, "forecaster").length >= 2) break;
      await t.sleep(250);
    }

    await live.session.start(BOB_NOTE, {
      headers: { authorization: BOB_AUTHORIZATION },
      turnPolicy: "steer",
    });
    const shared = await live.result();
    shared.expectOk();
    await t.require(
      taskStarts(shared.events, "forecaster"),
      satisfies(
        (calls: ReturnType<typeof taskStarts>) =>
          calls.length === 2 && calls.every((call) => call.mode === "foreground"),
        "both lookups started in the foreground",
      ),
    );
    shared.event("task.detached", { data: { reason: "steer" }, count: 2 });
    t.judge("The reply acknowledges Bob's note that the team lunch moved to 1 pm.", {
      on: shared.message ?? "",
    }).soft(0.7);

    const result = await watchNextTurn(t, shared);
    result.expectOk();
    result.messageIncludes(/Lisbon/);
    t.judge(
      "The reply gives Alice one combined answer: Lisbon will be warmer than Oslo tomorrow.",
      { on: result.message ?? "" },
    ).gate(0.7);

    const events = [...shared.events, ...result.events];
    const forecasterIds = taskStarts(events, "forecaster").map((call) => call.taskId);
    t.check(
      taskResultDeliveries(events),
      satisfies(
        (deliveries: readonly (readonly string[])[]) =>
          deliveries.length === 1 &&
          deliveries[0]?.length === 2 &&
          forecasterIds.every((taskId) => deliveries[0]?.includes(taskId)),
        "both forecasts arrive together in one task.result message",
      ),
    );
    t.check(
      forecasterIds.length,
      satisfies((count: number) => count === 2, "no lookup is delegated twice"),
    );
    result.noFailedActions();
  },
});
