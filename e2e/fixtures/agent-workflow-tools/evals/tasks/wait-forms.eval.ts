import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { startedTaskIds, taskResultDeliveries } from "./helpers";

/**
 * Alice sets a short reminder and waits for it. A wait with a zero timeout
 * returns the task's current state at once, an untimed wait returns the
 * result as its tool result, and a second wait on the same task in the same
 * step is refused. The result reaches the model once, through the wait.
 */
export default defineEval({
  description: "task_wait returns a zero-timeout state, the settled result, and one refusal.",
  timeoutMs: 120_000,
  async test(t) {
    const turn = await t.send("Alice would like a short reminder and will wait. TASKS-WAIT-START");
    turn.expectOk();
    const [taskId] = await t.require(
      startedTaskIds(turn.events, "remind_later"),
      satisfies(
        (taskIds: readonly string[]) => taskIds.length === 1,
        "the reminder started as one detached task",
      ),
    );

    turn.calledTool("remind_later", { count: 1, output: { status: "working", taskId } });
    turn.calledTool("task_wait", {
      count: 1,
      input: { taskId, timeout: 0 },
      output: { status: "timed_out", taskId },
    });
    turn.calledTool("task_wait", {
      count: 1,
      input: { taskId },
      output: {
        name: "remind_later",
        outcome: { output: { reminder: "stretch" }, status: "completed" },
        status: "settled",
        taskId,
      },
    });
    turn.calledTool("task_wait", {
      count: 1,
      output: { code: "TASK_ALREADY_WAITED" },
      status: "failed",
    });
    turn.messageIncludes(
      new RegExp(
        `TASKS-WAITED <task_result id="${taskId}" tool="remind_later" status="completed">`,
      ),
    );
    turn.messageIncludes("Reminder: stretch");
    t.check(
      taskResultDeliveries(turn.events),
      satisfies(
        (deliveries: readonly (readonly string[])[]) => deliveries.length === 0,
        "the wait took the result, so no task.result message delivers it again",
      ),
    );
    turn.event("task.ended", { count: 1, data: { taskId } });
    // The wait took the result, so the turn never held: it opened to input only at its end.
    turn.event("session.waiting", { count: 1 });
  },
});
