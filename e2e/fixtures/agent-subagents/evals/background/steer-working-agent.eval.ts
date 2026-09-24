import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { receiptTaskIds, taskResultDeliveries, taskStarts, watchNextTurn } from "./helpers";

const REQUEST = [
  "Hi, this is Alice from the product team.",
  "Please ask the launch-writer to draft the launch announcement for the Orbit Notebook.",
  "No rush, share it here when it is ready.",
].join(" ");
const FOLLOW_UP = [
  "One more thing for the launch announcement you already asked for:",
  "it should mention that the Orbit Notebook costs $49 per team each month.",
].join(" ");

/**
 * A follow-up about work already in progress goes to the working agent
 * through its agentId: no second writer starts, and one draft arrives that
 * includes the follow-up.
 */
export default defineEval({
  description:
    "A follow-up for a working background agent is sent to it instead of starting new work.",
  tags: ["real-model"],
  timeoutMs: 300_000,
  async test(t) {
    const first = await t.send(REQUEST);
    first.expectOk();
    const [taskId] = await t.require(
      receiptTaskIds(first, "launch-writer"),
      satisfies(
        (taskIds: readonly string[]) => taskIds.length === 1,
        "one launch-writer call that returned a background receipt",
      ),
    );

    const followUp = await first.session.send(FOLLOW_UP);
    followUp.expectOk();
    followUp.calledTool("launch-writer", { count: 1, input: { agentId: taskId } });
    t.judge(
      "The assistant tells Alice briefly that the price was passed on for the draft in progress. It does not present a draft or start a separate one.",
      { on: followUp.message ?? "" },
    ).gate(0.7);

    const result = await watchNextTurn(t, followUp);
    result.expectOk();
    result.messageIncludes(/\$49/);

    const events = [...first.events, ...followUp.events, ...result.events];
    t.check(
      taskStarts(events, "launch-writer"),
      satisfies(
        (calls: ReturnType<typeof taskStarts>) => calls.length === 1 && calls[0]?.taskId === taskId,
        "the follow-up joins the working writer; no second writer starts",
      ),
    );
    t.check(
      taskResultDeliveries(events),
      satisfies(
        (deliveries: readonly (readonly string[])[]) =>
          deliveries.length === 1 && deliveries[0]?.join() === taskId,
        "exactly one result arrives for the draft",
      ),
    );
    result.noFailedActions();
  },
});
