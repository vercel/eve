import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { startedTaskIds, waitForStarts } from "./helpers";

const BOB = { "x-eve-forwarded-principal-id": "bob" };

/**
 * Alice and Bob share a session. Alice's turn waits on her reminder when Bob
 * writes. Only a turn's own principal can steer it, so Bob's message does not
 * interrupt Alice's wait: her turn finishes with the reminder's result, and
 * Bob's message then starts a turn of his own.
 */
export default defineEval({
  description: "Another principal's message waits for the turn to end instead of steering it.",
  timeoutMs: 120_000,
  async test(t) {
    const conversation = await t.session();
    const live = await conversation.start(
      "Alice would like a reminder to review the report. TASKS-PRINCIPAL-START",
    );
    await waitForStarts(t, live, "remind_later", 1);
    await live.waitForEvent("actions.requested", {
      data: {
        actions: (actions) =>
          actions.some((action) => "toolName" in action && action.toolName === "task_wait"),
      },
    });
    const [taskId] = startedTaskIds(live.events, "remind_later");

    const bob = await conversation.send("Bob here with a question about lunch. TASKS-BOB", {
      headers: BOB,
      turnPolicy: "steer",
    });
    const alice = await live.result();

    alice.expectOk();
    alice.calledTool("task_wait", {
      count: 1,
      input: { taskId: taskId! },
      output: { status: "settled", taskId },
    });
    alice.messageIncludes("TASKS-ALICE");
    alice.messageIncludes("Reminder: review the report");
    alice.notEvent("message.received", { data: { message: /TASKS-BOB/u } });

    bob.expectOk();
    bob.messageIncludes("TASKS-BOB-REPLY");
    const turnIds = (events: typeof alice.events) =>
      events.flatMap((event) => (event.type === "turn.started" ? [event.data.turnId] : []));
    t.check(
      { alice: turnIds(alice.events), bob: turnIds(bob.events) },
      satisfies(
        (ids: { readonly alice: readonly string[]; readonly bob: readonly string[] }) =>
          ids.alice.length === 1 && ids.bob.length === 1 && ids.alice[0] !== ids.bob[0],
        "Bob's message starts its own turn after Alice's ends",
      ),
    );
  },
});
