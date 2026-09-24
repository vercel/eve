import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { receiptTaskIds, taskResultDeliveries, watchNextTurn } from "./helpers";

/**
 * A `detach: true` tool returns a receipt at once, the turn ends, and the
 * reminder arrives later in its own result turn.
 */
export default defineEval({
  description: "A detach: true call returns a receipt, then its result arrives in a result turn.",
  timeoutMs: 120_000,
  async test(t) {
    const first = await t.send(
      "Alice would like a reminder about the office plants. BG-REMIND-START",
    );
    first.expectOk();
    first.messageIncludes("BG-STARTED");
    first.notEvent("message.received", { data: { kind: "task.result" } });
    const [taskId] = await t.require(
      receiptTaskIds(first, "remind_later"),
      satisfies(
        (taskIds: readonly string[]) => taskIds.length === 1,
        "the reminder returned one background receipt",
      ),
    );

    const result = await watchNextTurn(t, first);
    result.expectOk();
    result.messageIncludes("BG-RESULT");
    result.messageIncludes("Reminder: water the office plants");
    result.event("task.settled", { count: 1, data: { status: "completed", taskId } });
    t.check(
      taskResultDeliveries(result.events),
      satisfies(
        (deliveries: readonly (readonly string[])[]) =>
          deliveries.length === 1 && deliveries[0]?.join() === taskId,
        "the reminder arrives in one task.result message",
      ),
    );
  },
});
