import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { detachedTaskIds, taskResultDeliveries, taskStarts, watchNextTurn } from "./helpers";

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
 * A shared thread where Bob posts an unrelated note while Alice's forecast
 * lookups run. The note moves the lookups the turn is waiting on to the
 * background as one group, whether the model requested them together or one
 * at a time, so Alice still gets one combined answer instead of one post per
 * lookup, and nothing is delegated twice.
 */
export default defineEval({
  description:
    "An unrelated message in a shared thread does not fragment another user's request into several posts.",
  tags: ["real-model"],
  timeoutMs: 240_000,
  async test(t) {
    const conversation = await t.session();
    const live = await conversation.start(ALICE_REQUEST);
    // Every lookup the turn waits on is recorded before the first child
    // reports task.started, so the note detaches all of them from here.
    await live.waitForEvent("task.started", { data: { name: "forecaster" } });

    await live.session.start(BOB_NOTE, {
      headers: { authorization: BOB_AUTHORIZATION },
      turnPolicy: "steer",
    });
    const shared = await live.result();
    shared.expectOk();
    const detached = await t.require(
      detachedTaskIds(shared.events),
      satisfies(
        (taskIds: readonly string[]) => taskIds.length > 0,
        "Bob's note moves Alice's waiting lookups to the background",
      ),
    );
    t.judge("The reply acknowledges Bob's note that the team lunch moved to 1 pm.", {
      on: shared.message ?? "",
    }).soft(0.7);
    t.judge(
      "The reply does not yet give Alice a final answer about which city will be warmer tomorrow.",
      { on: shared.message ?? "" },
    ).soft(0.7);

    const result = await watchNextTurn(t, shared);
    result.expectOk();
    result.messageIncludes(/Lisbon/);
    t.judge(
      "The reply gives Alice one combined answer: Lisbon will be warmer than Oslo tomorrow.",
      { on: result.message ?? "" },
    ).gate(0.7);

    const events = [...shared.events, ...result.events];
    t.check(
      taskResultDeliveries(events).filter((taskIds) =>
        taskIds.some((taskId) => detached.includes(taskId)),
      ),
      satisfies(
        (deliveries: readonly (readonly string[])[]) =>
          deliveries.length === 1 && detached.every((taskId) => deliveries[0]?.includes(taskId)),
        "the moved lookups arrive together in one task.result message",
      ),
    );
    t.check(
      taskStarts(events, "forecaster").length,
      satisfies((count: number) => count >= 1 && count <= 2, "no lookup is delegated twice"),
    );
    result.noFailedActions();
  },
});
