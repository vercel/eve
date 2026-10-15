import { defineEval } from "eve/evals";

/**
 * `canary_deploy` is a task that would watch its canary for an hour.
 * `eve__task_cancel` stops it at once: the call settles as cancelled, no result is
 * ever delivered, and with nothing left working the turn ends. The task ends once its run
 * finishes unwinding, which may be after the turn: a task can outlive the turn that cancels it.
 */
export default defineEval({
  description: "eve__task_cancel stops a working task, which then never reports a result.",
  async test(t) {
    const turn = await t.send("WORKFLOW-CANARY-CANCEL");
    turn.expectOk();

    turn.event("task.started", {
      count: 1,
      data: { name: "canary_deploy", startedBy: { callId: "canary" } },
    });
    turn.calledTool("eve__task_cancel", {
      count: 1,
      output: /^Stopped \S+; it won't report back\.$/u,
    });
    turn.event("call.settled", { count: 1, data: { callId: "canary", outcome: "interrupted" } });
    turn.calledTool("canary_deploy", { count: 0 });
    turn.event("turn.settled", { count: 1, data: { outcome: "completed" } });
    turn.messageIncludes(
      /WORKFLOW-CANARY-RESULT Stopped canary_deploy-\w{6}; it won't report back\./u,
    );
    const ended = await t.target
      .watchTurn(turn.session.sessionId, {
        startIndex: 0,
        until: (event) => event.type === "task.ended",
      })
      .result();
    ended.event("task.ended", { count: 1, data: { outcome: "cancelled" } });
    t.noFailedActions();
  },
});
