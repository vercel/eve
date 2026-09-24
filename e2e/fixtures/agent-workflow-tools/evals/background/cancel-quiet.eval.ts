import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { receiptTaskIds, taskResultDeliveries, waitForStarts } from "./helpers";

/**
 * Alice sets a reminder, then changes her mind while the turn still waits on
 * it. Her message moves the reminder to the background, the model stops it
 * with task_cancel, and the cancelled reminder never wakes the model: the
 * next turn after the reminder's time is Alice's own follow-up.
 */
export default defineEval({
  description: "A task cancelled with task_cancel never starts a result turn.",
  timeoutMs: 120_000,
  async test(t) {
    const session = await t.session();
    const live = await session.start(
      "Alice would like a reminder about the office plants. BG-CANCEL-START",
    );
    await waitForStarts(t, live, "remind_later", 1);

    const change = await live.session.start("Alice changed her mind about the reminder. BG-STOP", {
      turnPolicy: "steer",
    });
    const stopped = await live.result();
    await change.result();
    stopped.expectOk();
    const [taskId] = await t.require(
      receiptTaskIds(stopped, "remind_later"),
      satisfies(
        (taskIds: readonly string[]) => taskIds.length === 1,
        "the reminder moved to the background with one receipt",
      ),
    );
    stopped.messageIncludes("BG-CANCELLED");
    stopped.calledTool("task_cancel", {
      count: 1,
      input: { taskId: taskId! },
      output: { status: "cancelled" },
    });
    stopped.event("task.settled", { count: 1, data: { status: "cancelled", taskId } });
    const afterCancel = stopped.session.state.streamIndex;

    // Past the reminder's 20 seconds: a cancelled task has nothing to report.
    await t.sleep(25_000);
    const followUp = await stopped.session.send("Alice is checking in. BG-IDLE");
    followUp.expectOk();
    followUp.messageIncludes("BG-IDLE-REPLY");

    // The first turn after the cancel is Alice's follow-up, not a result turn.
    const next = await t.target.watchTurn(stopped.sessionId, { startIndex: afterCancel }).result();
    next.messageIncludes("BG-IDLE-REPLY");
    t.check(
      taskResultDeliveries(next.events),
      satisfies(
        (deliveries: readonly (readonly string[])[]) => deliveries.length === 0,
        "no task.result message follows the cancel",
      ),
    );
  },
});
