import { defineEval } from "eve/evals";

/**
 * The provided `sleep` tool races its timer against the call's
 * `interruptSignal`. A steering message ends a ten-minute sleep at once, and
 * the same turn continues with the message and the interrupted result.
 */
export default defineEval({
  description: "Steering ends a sleep early without cancelling the turn.",
  async test(t) {
    const session = await t.session();
    const live = await session.start("WORKFLOW-SLEEP-START");
    await live.waitForEvent("actions.requested", {
      data: {
        actions: (actions) =>
          actions.some((action) => action.kind === "tool-call" && action.toolName === "sleep"),
      },
    });

    const update = await live.session.start(
      "Alice has the numbers now, so there is no need to wait.",
      {
        turnPolicy: "steer",
      },
    );
    const turn = await live.result();
    await update.result();

    turn.calledTool("sleep", { count: 1, output: { interrupted: true } });
    turn.event("message.received", { count: 2 });
    turn.event("turn.completed", { count: 1 });
    turn.notEvent("turn.cancelled");
    turn.messageIncludes("WORKFLOW-SLEEP-RESULT Stopped early because a new message arrived.");
    t.noFailedActions();
  },
});
