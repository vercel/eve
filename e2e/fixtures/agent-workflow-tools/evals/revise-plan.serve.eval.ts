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
    drafted.calledTool("revise_plan", {
      count: 1,
      output: /^Started task revise_plan-\w{6}\. Call revise_plan again with taskId/u,
    });
    drafted.messageIncludes('WORKFLOW-PLAN-RESULT {"revisions":["draft"]}');

    const revised = await drafted.session.send("WORKFLOW-PLAN-REVISE");
    revised.expectOk();
    revised.calledTool("revise_plan", { count: 2, output: /^Sent to task revise_plan-\w{6}\.$/u });
    revised.calledTool("task_wait", { output: /^Stopped waiting after/u });
    revised.calledTool("task_cancel", { count: 1, output: { status: "cancelled" } });
    revised.event("task.settled", { count: 1, data: { callId: "plan-hold", status: "cancelled" } });
    revised.event("task.settled", {
      count: 1,
      data: {
        callId: "plan-final",
        output: { revisions: ["draft", "final"] },
        status: "completed",
      },
    });
    revised.messageIncludes('WORKFLOW-PLAN-RESULT {"revisions":["draft","final"]}');

    t.eventsSatisfy("every call reaches the one task the draft started", (events) => {
      const taskIds = events.flatMap((event) =>
        event.type === "task.started" ? [event.data.taskId] : [],
      );
      return taskIds.length === 3 && new Set(taskIds).size === 1;
    });
    t.noFailedActions();
  },
});
