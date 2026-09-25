import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { startedTaskIds, taskResultDeliveries } from "./helpers";

/**
 * Alice's reminder starts as a detached task and returns a receipt. The
 * model waits one second, and the wait ends with the task still working.
 * The model then replies without the result, so eve holds the turn behind a
 * waiting boundary, and the reminder's result arrives in the same turn as a
 * task.result message.
 */
export default defineEval({
  description: "A timed-out wait leaves the task working, and a held turn delivers its result.",
  timeoutMs: 120_000,
  async test(t) {
    const turn = await t.send("Alice would like a reminder about the plants. TASKS-TIMEOUT-START");
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
      input: { taskId, timeout: 1_000 },
      output: { status: "timed_out", taskId },
    });
    turn.event("task.started", {
      count: 1,
      data: { generation: 1, mode: "detached", resumable: false, taskId },
    });

    // One turn: the reply, session.waiting while it holds, then the result and the final reply.
    turn.event("turn.started", { count: 1 });
    turn.event("turn.completed", { count: 1 });
    turn.event("session.waiting", { count: 2 });
    turn.event("message.completed", { count: 1, data: { message: "TASKS-STILL-WORKING" } });
    t.check(
      taskResultDeliveries(turn.events),
      satisfies(
        (deliveries: readonly (readonly string[])[]) =>
          deliveries.length === 1 && deliveries[0]?.join() === taskId,
        "the reminder's result arrives in exactly one task.result message",
      ),
    );
    turn.eventsSatisfy("the result arrives after the waiting boundary", (events) => {
      const boundary = events.findIndex((event) => event.type === "session.waiting");
      const delivered = events.findIndex(
        (event) => event.type === "message.received" && event.data.kind === "task.result",
      );
      return boundary >= 0 && delivered > boundary;
    });
    turn.messageIncludes("TASKS-RESULT");
    turn.messageIncludes("Reminder: water the plants");
    turn.event("task.settled", { count: 1, data: { generation: 1, status: "completed", taskId } });
    turn.event("task.ended", { count: 1, data: { taskId } });
  },
});
