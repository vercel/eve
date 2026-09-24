import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { receiptTaskIds, taskResultDeliveries, watchNextTurn } from "./helpers";

/**
 * A background export job outlives its 3-second time limit. eve stops it and
 * reports `TIMED_OUT` in a result turn.
 */
export default defineEval({
  description: "A background task's deadline is reported as TIMED_OUT in a result turn.",
  timeoutMs: 120_000,
  async test(t) {
    const first = await t.send("Alice would like the nightly export started. BG-DEADLINE-START");
    first.expectOk();
    first.messageIncludes("BG-STARTED");
    const [taskId] = await t.require(
      receiptTaskIds(first, "stuck_job"),
      satisfies(
        (taskIds: readonly string[]) => taskIds.length === 1,
        "the export returned one background receipt",
      ),
    );

    const result = await watchNextTurn(t, first);
    result.expectOk();
    result.messageIncludes('status="failed" code="TIMED_OUT"');
    result.event("task.settled", {
      count: 1,
      data: { error: { code: "TIMED_OUT" }, status: "failed", taskId },
    });
    t.check(
      taskResultDeliveries(result.events),
      satisfies(
        (deliveries: readonly (readonly string[])[]) =>
          deliveries.length === 1 && deliveries[0]?.join() === taskId,
        "the timeout arrives in one task.result message",
      ),
    );
  },
});
