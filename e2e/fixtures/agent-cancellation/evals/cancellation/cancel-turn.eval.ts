import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const TOOL_NAME = "wait-for-cancellation";

/**
 * Cancel an in-flight turn over the eve HTTP channel.
 *
 * Flow: start a turn that hangs mid-tool, request cooperative cancellation,
 * and assert the turn settles as `turn.cancelled` followed by
 * `session.waiting` with zero failure events. Then prove the session accepts a
 * follow-up normally and a late duplicate cancel is accepted as a benign no-op.
 */
export default defineEval({
  tags: ["real-model"],
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

    const followUp = await t.send({ message: "Reply with exactly CANCELLATION-FOLLOW-UP-OK." });
    followUp.expectOk();
    followUp.notEvent("turn.cancelled");
    followUp.notEvent("turn.failed");
    followUp.notEvent("session.failed");
    followUp.messageIncludes(/CANCELLATION-FOLLOW-UP-OK/i);

    const late = await t.cancel();
    await t.require(
      late,
      satisfies(
        (value: typeof late) => value.sessionId === live.sessionId && value.status === "accepted",
        "a live parked session accepts a late cancel as a no-op",
      ),
    );

    const afterLateCancel = await t.send({
      message: "Reply with exactly CANCELLATION-LATE-NOOP-OK.",
    });
    afterLateCancel.expectOk();
    afterLateCancel.notEvent("turn.cancelled");
    afterLateCancel.notEvent("turn.failed");
    afterLateCancel.notEvent("session.failed");
    afterLateCancel.messageIncludes(/CANCELLATION-LATE-NOOP-OK/i);

    t.event("turn.cancelled", { count: 1 });
  },
});
