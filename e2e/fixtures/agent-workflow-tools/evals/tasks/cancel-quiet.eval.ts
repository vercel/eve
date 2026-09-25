import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { startedTaskIds, taskResultDeliveries } from "./helpers";

/**
 * Alice sets a reminder, which starts as a detached task and returns a
 * receipt at once, so the turn holds. She then changes her mind, the model
 * stops it with task_cancel in the same turn, which then ends, and the
 * cancelled reminder never reports: the next turn after the reminder's time
 * is Alice's own follow-up.
 */
export default defineEval({
  description: "A task cancelled with task_cancel never reports a result.",
  timeoutMs: 120_000,
  async test(t) {
    const conversation = await t.session();
    const started = await conversation.start(
      "Alice would like a reminder about the office plants. BG-CANCEL-START",
    );
    await started.waitForEvent("turn.completed", { data: { held: true } });
    const [taskId] = await t.require(
      startedTaskIds(started.events, "remind_later"),
      satisfies(
        (taskIds: readonly string[]) => taskIds.length === 1,
        "the reminder started as one detached task",
      ),
    );

    // Alice writes again while the turn holds on the reminder.
    const stopped = await conversation.send("Alice changed her mind about the reminder. BG-STOP", {
      turnPolicy: "steer",
    });
    stopped.expectOk();
    stopped.messageIncludes("BG-CANCELLED");
    stopped.calledTool("task_cancel", {
      count: 1,
      input: { taskId: taskId! },
      output: { status: "cancelled" },
    });
    const turn = await started.result();
    turn.messageIncludes("BG-CANCELLED");
    turn.event("task.settled", { count: 1, data: { status: "cancelled", taskId } });
    // A workflow tool call is not resumable: it ends with its only generation.
    turn.event("task.ended", { count: 1, data: { taskId } });
    const afterCancel = conversation.state.streamIndex;

    // Past the reminder's 20 seconds: a cancelled task has nothing to report.
    await t.sleep(25_000);
    const followUp = await conversation.send("Alice is checking in. BG-IDLE");
    followUp.expectOk();
    followUp.messageIncludes("BG-IDLE-REPLY");

    // The first turn after the cancel is Alice's follow-up; no result ever arrives.
    const next = await t.target
      .watchTurn(conversation.sessionId, { startIndex: afterCancel })
      .result();
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
