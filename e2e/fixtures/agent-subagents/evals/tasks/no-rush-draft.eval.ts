import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { heldReply, receiptTaskIds, taskResultDeliveries, taskStarts } from "./helpers";

const REQUEST = [
  "Hi, this is Alice from the product team.",
  "Please ask the launch-writer to draft the launch announcement for the Orbit Notebook.",
  "There is no rush: I am heading into a meeting and will read it afterward,",
  "so share the draft here once it is ready.",
].join(" ");

/**
 * Work the user does not need to wait on is not waited on: the writer's call
 * returns a receipt, the turn shows a short reply at its waiting boundary and
 * holds, and the same turn reports the draft without polling or delegating
 * again once the writer finishes.
 */
export default defineEval({
  description:
    "A no-rush request leaves the writer's task running and reports the draft when it arrives.",
  tags: ["real-model"],
  timeoutMs: 300_000,
  async test(t) {
    const turn = await t.send(REQUEST);
    turn.expectOk();
    const [taskId] = await t.require(
      receiptTaskIds(turn, "launch-writer"),
      satisfies(
        (taskIds: readonly string[]) => taskIds.length === 1,
        "one launch-writer call that returned a receipt",
      ),
    );
    t.judge(
      "The assistant tells Alice, in a few sentences at most, that the launch announcement draft was started and that it will be shared when it is ready. It does not present a draft.",
      { on: heldReply(turn) ?? "" },
    ).gate(0.7);

    turn.messageIncludes(/Orbit Notebook/i);
    t.judge(
      "The assistant shares the finished launch announcement draft for the Orbit Notebook with Alice.",
      { on: turn.message ?? "" },
    ).gate(0.7);

    // One delegation, reported once after the waiting boundary: no polling,
    // no repeated calls, no cancellation.
    turn.eventsSatisfy("the draft arrives after the turn's waiting boundary", (events) => {
      const boundary = events.findIndex(
        (event) => event.type === "turn.completed" && event.data.held === true,
      );
      const result = events.findIndex(
        (event) => event.type === "message.received" && event.data.kind === "task.result",
      );
      return boundary >= 0 && result > boundary;
    });
    t.check(
      taskResultDeliveries(turn.events),
      satisfies(
        (deliveries: readonly (readonly string[])[]) =>
          deliveries.length === 1 && deliveries[0]?.join() === taskId,
        "the draft arrives in exactly one task.result message",
      ),
    );
    t.check(
      taskStarts(turn.events, "launch-writer"),
      satisfies(
        (calls: ReturnType<typeof taskStarts>) =>
          calls.length === 1 && calls[0]?.taskId === taskId && calls[0].mode === "detached",
        "one detached delegation, never repeated",
      ),
    );
    t.check(
      turn.toolCalls.filter((call) => call.name === "launch-writer").length,
      satisfies((count: number) => count === 1, "the writer is never called again to check on it"),
    );
    turn.notCalledTool("task_wait");
    turn.notCalledTool("task_cancel");
    turn.noFailedActions();
  },
});
