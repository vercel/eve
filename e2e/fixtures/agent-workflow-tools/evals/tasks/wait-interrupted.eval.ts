import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { startedTaskIds, waitForStarts } from "./helpers";

/**
 * Alice sets a long reminder and the model waits on it. When Alice writes
 * again, her message ends the wait but not the task: the wait returns
 * `interrupted` while the reminder keeps working, and the model, having read
 * her message, stops the reminder itself with task_cancel.
 */
export default defineEval({
  description: "A steering message interrupts task_wait and leaves the task working.",
  timeoutMs: 120_000,
  async test(t) {
    const conversation = await t.session();
    const live = await conversation.start(
      "Alice would like a reminder to call Bob. TASKS-INTERRUPT-START",
    );
    await waitForStarts(t, live, "remind_later", 1);
    await live.waitForEvent("actions.requested", {
      data: {
        actions: (actions) =>
          actions.some((action) => "toolName" in action && action.toolName === "task_wait"),
      },
    });
    const [taskId] = startedTaskIds(live.events, "remind_later");

    const message = await conversation.send(
      "Alice has a quick question about the reminder. TASKS-PING",
      { turnPolicy: "steer" },
    );
    message.expectOk();
    const turn = await live.result();
    turn.expectOk();
    turn.calledTool("task_wait", {
      count: 1,
      input: { taskId: taskId! },
      output: { status: "interrupted", taskId },
    });
    turn.calledTool("task_cancel", {
      count: 1,
      input: { taskId: taskId! },
      output: { status: "cancelled" },
    });
    turn.messageIncludes("TASKS-INTERRUPTED");
    // One turn: the message joined it instead of starting another.
    turn.event("turn.started", { count: 1 });
    t.check(
      turn.events,
      satisfies((events: typeof turn.events) => {
        const interrupted = events.findIndex(
          (event) =>
            event.type === "action.result" &&
            event.data.result.kind === "tool-result" &&
            event.data.result.toolName === "task_wait",
        );
        const settled = events.findIndex(
          (event) => event.type === "task.settled" && event.data.taskId === taskId,
        );
        return interrupted >= 0 && settled > interrupted;
      }, "the reminder was still working when the wait ended, and settled only when cancelled"),
    );
    turn.event("task.settled", { count: 1, data: { status: "cancelled", taskId } });
    turn.notEvent("message.received", { data: { kind: "task.result" } });
  },
});
