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
    const session = await t.session();
    const live = await session.start("Please wait for cancellation.");
    await live.waitForEvent("call.requested", { data: { capability: { name: TOOL_NAME } } });
    t.log(`Tool call observed mid-turn; cancelling session ${live.sessionId}.`);

    const cancelled = await live.cancel();
    await t.require(
      cancelled,
      satisfies(
        (value: typeof cancelled) =>
          value.status === "accepted" && value.sessionId === live.sessionId,
        "cancel request is accepted with status 'accepted'",
      ),
    );

    const cancelledTurn = await live.result();
    cancelledTurn.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });
    cancelledTurn.eventOrder([{ data: { outcome: "cancelled" }, type: "turn.settled" }]);
    cancelledTurn.notEvent("turn.settled", { data: { outcome: "failed" } });
    cancelledTurn.notEvent("model.settled", { data: { outcome: "failed" } });
    cancelledTurn.notEvent("session.ended", { data: { outcome: "failed" } });

    const followUp = await session.send("Reply with exactly CANCELLATION-FOLLOW-UP-OK.");
    followUp.expectOk();
    followUp.notEvent("turn.settled", { data: { outcome: "cancelled" } });
    followUp.notEvent("turn.settled", { data: { outcome: "failed" } });
    followUp.notEvent("session.ended", { data: { outcome: "failed" } });
    followUp.messageIncludes(/CANCELLATION-FOLLOW-UP-OK/i);

    const late = await session.cancel();
    await t.require(
      late,
      satisfies(
        (value: typeof late) => value.status === "accepted" && value.sessionId === live.sessionId,
        "a live parked session accepts a late cancel as a no-op",
      ),
    );

    const afterLateCancel = await session.send("Reply with exactly CANCELLATION-LATE-NOOP-OK.");
    afterLateCancel.expectOk();
    afterLateCancel.notEvent("turn.settled", { data: { outcome: "cancelled" } });
    afterLateCancel.notEvent("turn.settled", { data: { outcome: "failed" } });
    afterLateCancel.notEvent("session.ended", { data: { outcome: "failed" } });
    afterLateCancel.messageIncludes(/CANCELLATION-LATE-NOOP-OK/i);

    t.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });
  },
});
