import { defineEval } from "eve/evals";

/**
 * `stage_deploy` defines `task()`. Its call returns a receipt, `task_wait`
 * parks the turn with `turn.waiting` until the task settles, and clients read
 * the outcome from `task.settled` while the result reaches the model before
 * the final reply.
 */
export default defineEval({
  description: "A task tool starts a task, task_wait waits on it, and its result is delivered.",
  async test(t) {
    const turn = await t.send("WORKFLOW-STAGE-WAIT");
    turn.expectOk();

    turn.calledTool("stage_deploy", { count: 1, output: /^Started task stage_deploy-\w{6}\.$/u });
    turn.event("task.started", { count: 1, data: { callId: "stage", name: "stage_deploy" } });
    turn.calledTool("task_wait", { count: 1, output: /stage_deploy-\w{6} completed/u });
    turn.event("task.settled", {
      count: 1,
      data: { callId: "stage", output: { plan: "deploy api" }, status: "completed" },
    });
    turn.eventOrder([
      { data: { callId: "stage" }, type: "task.started" },
      { type: "turn.waiting" },
      { data: { callId: "stage" }, type: "task.settled" },
      { data: { message: /^WORKFLOW-STAGE-RESULT / }, type: "message.completed" },
      { type: "turn.completed" },
    ]);
    turn.messageIncludes("WORKFLOW-STAGE-RESULT");
    turn.messageIncludes('"plan":"deploy api"');
    t.noFailedActions();
  },
});
