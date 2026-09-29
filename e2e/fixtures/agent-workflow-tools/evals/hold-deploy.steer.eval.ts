import { defineEval } from "eve/evals";

/**
 * `hold_deploy` rejects once its `abortSignal` aborts. A steering message
 * aborts it while the turn waits on the call, and the call settles as
 * `{ interrupted: true }` instead of failing. The same turn continues with
 * Alice's message.
 */
export default defineEval({
  description: "A steering message stops a waited workflow tool whose body rejects on abort.",
  async test(t) {
    const session = await t.session();
    const live = await session.start("WORKFLOW-HOLD-START");
    await live.waitForEvent("actions.requested", {
      data: {
        actions: (actions) =>
          actions.some(
            (action) => action.kind === "tool-call" && action.toolName === "hold_deploy",
          ),
      },
    });

    const update = await live.session.start("Alice asks Bob to read the rollout notes first.", {
      turnPolicy: "steer",
    });
    const turn = await live.result();
    await update.result();

    turn.calledTool("hold_deploy", { count: 1, output: { interrupted: true } });
    turn.event("message.received", { count: 2 });
    turn.event("turn.completed", { count: 1 });
    turn.notEvent("turn.cancelled");
    turn.messageIncludes('WORKFLOW-HOLD-RESULT {"interrupted":true}');
    t.noFailedActions();
  },
});
