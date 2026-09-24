import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { receiptTaskIds, taskResultDeliveries, taskStarts, watchNextTurn } from "./helpers";

const REQUEST = [
  "Hi, this is Alice from the product team.",
  "Please ask the launch-writer to draft the launch announcement for the Orbit Notebook.",
  "There is no rush: I am heading into a meeting and will read it afterward,",
  "so share the draft here once it is ready.",
].join(" ");

/**
 * Work the user does not need to wait on is not waited on: the writer's call
 * returns a receipt, the first turn ends with a short reply, and a later
 * result turn reports the draft without polling or delegating again.
 */
export default defineEval({
  description:
    "A no-rush request leaves the writer's task running and reports the draft when it arrives.",
  tags: ["real-model"],
  timeoutMs: 300_000,
  async test(t) {
    const first = await t.send(REQUEST);
    first.expectOk();
    const [taskId] = await t.require(
      receiptTaskIds(first, "launch-writer"),
      satisfies(
        (taskIds: readonly string[]) => taskIds.length === 1,
        "one launch-writer call that returned a receipt",
      ),
    );
    first.notEvent("message.received", { data: { kind: "task.result" } });
    t.judge(
      "The assistant tells Alice, in a few sentences at most, that the launch announcement draft was started and that it will be shared when it is ready. It does not present a draft.",
      { on: first.message ?? "" },
    ).gate(0.7);

    const result = await watchNextTurn(t, first);
    result.expectOk();
    result.messageIncludes(/Orbit Notebook/i);
    t.judge(
      "The assistant shares the finished launch announcement draft for the Orbit Notebook with Alice.",
      { on: result.message ?? "" },
    ).gate(0.7);

    // One delegation, reported once: no polling, no repeated calls, no cancellation.
    const events = [...first.events, ...result.events];
    t.check(
      taskResultDeliveries(events),
      satisfies(
        (deliveries: readonly (readonly string[])[]) =>
          deliveries.length === 1 && deliveries[0]?.join() === taskId,
        "the draft arrives in exactly one task.result message",
      ),
    );
    t.check(
      taskStarts(events, "launch-writer"),
      satisfies(
        (calls: ReturnType<typeof taskStarts>) =>
          calls.length === 1 && calls[0]?.taskId === taskId && calls[0].mode === "detached",
        "one detached delegation, never repeated",
      ),
    );
    t.check(
      [...first.toolCalls, ...result.toolCalls].filter((call) => call.name === "launch-writer")
        .length,
      satisfies((count: number) => count === 1, "the writer is never called again to check on it"),
    );
    first.notCalledTool("task_wait");
    result.notCalledTool("task_cancel");
    result.noFailedActions();
  },
});
