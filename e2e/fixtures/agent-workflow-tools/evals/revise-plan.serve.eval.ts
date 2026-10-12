import { defineEval } from "eve/evals";

/**
 * `revise_plan` is a `serve` tool whose run keeps every revision. Turn one
 * drafts the plan and ends with the task idle. Turn two sends the task work
 * that holds it busy, cancels that work, and revises the same task again: the
 * final result lists both revisions, so the body caught the cancelled
 * stretch's abort and kept its run and state.
 */
export default defineEval({
  description:
    "A resumable task is continued by taskId, cancelled, and continued again with its state intact.",
  timeoutMs: 90_000,
  async test(t) {
    const drafted = await t.send("WORKFLOW-PLAN-START");
    drafted.expectOk();
    // The model reads a receipt naming the task; the call settles with the task's reply.
    drafted.calledTool("revise_plan", { count: 1, output: { revisions: ["draft"] } });
    drafted.messageIncludes('WORKFLOW-PLAN-RESULT {"revisions":["draft"]}');

    const revised = await drafted.session.send("WORKFLOW-PLAN-REVISE");
    revised.expectOk();
    // Both calls reach the task by its id: the held one is interrupted, the final one completes.
    for (const status of ["interrupted", "completed"] as const) {
      revised.calledTool("revise_plan", {
        count: 1,
        input: { taskId: /^revise_plan-\w{6}$/u },
        status,
      });
    }
    revised.calledTool("eve__task_wait", { output: /^Stopped waiting after/u });
    revised.calledTool("eve__task_cancel", {
      count: 1,
      output: /^Stopped revise_plan-\w{6}'s current work;/u,
    });
    revised.event("call.settled", {
      count: 1,
      data: { callId: "plan-hold", outcome: "interrupted" },
    });
    revised.event("call.settled", {
      count: 1,
      data: {
        callId: "plan-final",
        output: { revisions: ["draft", "final"] },
        outcome: "completed",
      },
    });
    revised.messageIncludes('WORKFLOW-PLAN-RESULT {"revisions":["draft","final"]}');

    t.eventsSatisfy("every call reaches the one task the draft started", (events) => {
      const started = events.flatMap((event) =>
        event.type === "task.started" ? [event.data.taskId] : [],
      );
      const reached = events.flatMap((event) =>
        event.type === "call.started" && event.data.taskId !== undefined ? [event.data.taskId] : [],
      );
      return (
        started.length === 1 && reached.length === 3 && reached.every((id) => id === started[0])
      );
    });
    t.noFailedActions();
  },
});
