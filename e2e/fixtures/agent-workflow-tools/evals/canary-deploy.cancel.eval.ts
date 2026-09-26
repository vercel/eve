import { defineEval } from "eve/evals";

/**
 * `canary_deploy` is a task that would watch its canary for an hour.
 * `task_cancel` stops it at once: the call settles as cancelled, no result is
 * ever delivered, and with nothing left working the turn ends.
 */
export default defineEval({
  description: "task_cancel stops a working task, which then never reports a result.",
  async test(t) {
    const turn = await t.send("WORKFLOW-CANARY-CANCEL");
    turn.expectOk();

    turn.event("task.started", { count: 1, data: { callId: "canary", name: "canary_deploy" } });
    turn.calledTool("task_cancel", { count: 1, output: { status: "cancelled" } });
    turn.event("task.settled", { count: 1, data: { callId: "canary", status: "cancelled" } });
    turn.notEvent("task.settled", { data: { status: "completed" } });
    turn.notEvent("message.received", { data: { kind: "task.result" } });
    turn.event("turn.completed", { count: 1 });
    turn.messageIncludes('WORKFLOW-CANARY-RESULT {"status":"cancelled"}');
    t.noFailedActions();
  },
});
