import { defineEval } from "eve/evals";

/**
 * `stage_deploy` defines `task()`. The model gets a receipt for its call,
 * `eve__task_wait` pauses the turn until the task replies, and clients read
 * the outcome from the call's `call.settled` while the result reaches the
 * model before the final reply.
 */
export default defineEval({
  description:
    "A task tool starts a task, eve__task_wait waits on it, and its result is delivered.",
  async test(t) {
    const turn = await t.send("WORKFLOW-STAGE-WAIT");
    turn.expectOk();

    turn.calledTool("stage_deploy", { count: 1, output: { plan: "deploy api" } });
    turn.event("task.started", {
      count: 1,
      data: { name: "stage_deploy", startedBy: { callId: "stage" } },
    });
    turn.calledTool("eve__task_wait", { count: 1, output: /stage_deploy-\w{6} completed/u });
    turn.event("call.settled", {
      count: 1,
      data: { callId: "stage", output: { plan: "deploy api" }, outcome: "completed" },
    });
    turn.eventOrder([
      { data: { startedBy: { callId: "stage" } }, type: "task.started" },
      { type: "turn.paused" },
      { data: { callId: "stage" }, type: "call.settled" },
      { data: { phase: "reply", value: /^WORKFLOW-STAGE-RESULT / }, type: "content.completed" },
      { data: { outcome: "completed" }, type: "turn.settled" },
    ]);
    turn.messageIncludes("WORKFLOW-STAGE-RESULT");
    turn.messageIncludes('"plan":"deploy api"');
    t.noFailedActions();
  },
});
