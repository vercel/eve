import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { taskResultDeliveries, taskStarts } from "./helpers";

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
 * lookups run. Only a turn's own principal steers it, so the note waits for
 * Alice's turn to end instead of joining it: Alice gets one combined answer
 * that never mentions the note, and the note then starts a turn of Bob's own
 * that does not repeat her lookups.
 */
export default defineEval({
  description:
    "Another person's message in a shared thread waits for the running turn instead of steering it.",
  tags: ["real-model"],
  timeoutMs: 300_000,
  async test(t) {
    const conversation = await t.session();
    const live = await conversation.start(ALICE_REQUEST);
    await live.waitForEvent("task.started", { data: { name: "forecaster" } });

    const bob = await conversation.send(BOB_NOTE, {
      headers: { authorization: BOB_AUTHORIZATION },
      turnPolicy: "steer",
    });
    const alice = await live.result();

    alice.expectOk();
    alice.event("turn.started", { count: 1 });
    alice.notEvent("message.received", { data: { message: /team lunch/u } });
    alice.messageIncludes(/Lisbon/);
    t.judge(
      "The reply gives Alice one combined answer: Lisbon will be warmer than Oslo tomorrow.",
      { on: alice.message ?? "" },
    ).gate(0.7);
    t.judge("The reply does not mention the team lunch or its new time.", {
      on: alice.message ?? "",
    }).soft(0.7);
    t.check(
      taskStarts(alice.events, "forecaster").length,
      satisfies((count: number) => count >= 1 && count <= 2, "no lookup is delegated twice"),
    );
    t.check(
      taskResultDeliveries(alice.events).length,
      satisfies(
        (count: number) => count <= 1,
        "results no wait received arrive together in at most one task.result message",
      ),
    );
    alice.noFailedActions();

    bob.expectOk();
    bob.notCalledTool("forecaster");
    const turnIds = (events: typeof alice.events) =>
      events.flatMap((event) => (event.type === "turn.started" ? [event.data.turnId] : []));
    t.check(
      { alice: turnIds(alice.events), bob: turnIds(bob.events) },
      satisfies(
        (ids: { readonly alice: readonly string[]; readonly bob: readonly string[] }) =>
          ids.bob.length === 1 && !ids.alice.includes(ids.bob[0]!),
        "Bob's note starts its own turn after Alice's ends",
      ),
    );
    t.judge("The reply acknowledges Bob's note that the team lunch moved to 1 pm.", {
      on: bob.message ?? "",
    }).soft(0.7);
  },
});
