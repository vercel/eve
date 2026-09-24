import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { receiptTaskIds, taskResultDeliveries, watchNextTurn } from "./helpers";

/**
 * Two checks run with `detach: { timeout }`: the quick one returns its result
 * in the turn, and the slow one moves to the background when its timer fires
 * and reports later.
 */
export default defineEval({
  description: "detach: { timeout } detaches the slow call and not the fast one.",
  timeoutMs: 180_000,
  async test(t) {
    const first = await t.send(
      "Alice would like the lint and integration checks run. BG-TIMEOUT-START",
    );
    first.expectOk();
    first.messageIncludes("BG-TIMED");
    first.event("task.detached", { count: 1, data: { reason: "timeout" } });
    first.calledTool("timed_check", {
      count: 1,
      input: { label: "lint" },
      output: { label: "lint", passed: true },
    });
    const [taskId] = await t.require(
      receiptTaskIds(first, "timed_check"),
      satisfies(
        (taskIds: readonly string[]) => taskIds.length === 1,
        "only the slow check returned a receipt",
      ),
    );

    const result = await watchNextTurn(t, first);
    result.expectOk();
    result.messageIncludes("BG-RESULT");
    result.messageIncludes('"label": "integration"');
    t.check(
      taskResultDeliveries(result.events),
      satisfies(
        (deliveries: readonly (readonly string[])[]) =>
          deliveries.length === 1 && deliveries[0]?.join() === taskId,
        "the slow check reports in one task.result message",
      ),
    );
  },
});
