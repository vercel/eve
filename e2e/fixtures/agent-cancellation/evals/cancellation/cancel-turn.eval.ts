import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const TOOL_NAME = "wait-for-cancellation";

/**
 * Cancel an in-flight turn over the eve HTTP channel.
 *
 * Flow: start a turn that hangs mid-tool, request cooperative cancellation,
 * and assert the turn settles as `turn.cancelled` followed by
 * `session.waiting` with zero failure events. Then prove the session accepts a
 * follow-up normally and a late duplicate cancel reports the benign
 * `no_active_turn` outcome.
 */
export default defineEval({
  description: "Cancel an in-flight turn over the eve HTTP cancel route.",
  timeoutMs: 240_000,

  async test(t) {
    const live = await t.start("Please wait for cancellation.");
    await live.waitForEvent("actions.requested", {
      data: {
        actions: (actions) =>
          actions.some((action) => action.kind === "tool-call" && action.toolName === TOOL_NAME),
      },
    });
    t.log(`Tool call observed mid-turn; cancelling session ${live.sessionId}.`);

    const cancelled = await live.cancel();
    await t.require(
      cancelled,
      satisfies(
        (value: typeof cancelled) =>
          value.sessionId === live.sessionId && value.status === "accepted",
        "cancel request is accepted with status 'accepted'",
      ),
    );

    const cancelledTurn = await live.result();
    cancelledTurn.event("turn.cancelled", { count: 1 });
    cancelledTurn.eventOrder([{ type: "turn.cancelled" }, { type: "session.waiting" }]);
    cancelledTurn.notEvent("turn.failed");
    cancelledTurn.notEvent("step.failed");
    cancelledTurn.notEvent("session.failed");

    const followUp = await t.send("Reply with exactly CANCELLATION-FOLLOW-UP-OK.");
    followUp.expectOk();
    followUp.notEvent("turn.cancelled");
    followUp.notEvent("turn.failed");
    followUp.notEvent("session.failed");
    followUp.messageIncludes(/CANCELLATION-FOLLOW-UP-OK/i);

    let lateStatus: "accepted" | "no_active_turn" | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      lateStatus = (await t.cancel()).status;
      if (lateStatus === "no_active_turn") break;
      await t.sleep(500);
    }
    await t.require(
      lateStatus,
      satisfies(
        (value: typeof lateStatus) => value === "no_active_turn",
        "a late cancel reports no_active_turn",
      ),
    );

    t.event("turn.cancelled", { count: 1 });
  },
});
