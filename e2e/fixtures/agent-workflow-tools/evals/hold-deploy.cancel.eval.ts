import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

/**
 * Cancelling the turn cancels the workflow tool run holding it open. The turn
 * settles as cancelled followed by session.waiting, with no failure events,
 * and the session keeps taking messages.
 */
export default defineEval({
  timeoutMs: 60_000,
  description: "Cancelling a turn cancels the workflow tool run it is parked on.",
  async test(t) {
    const session = await t.session();
    const live = await session.start("WORKFLOW-HOLD-START");
    await live.waitForEvent("call.requested", { data: { capability: { name: "hold_deploy" } } });

    const cancelled = await live.cancel();
    await t.require(
      cancelled,
      satisfies(
        (value: typeof cancelled) => value.status === "accepted",
        "cancel request is accepted",
      ),
    );

    const turn = await live.result();
    turn.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });
    turn.eventOrder([{ data: { outcome: "cancelled" }, type: "turn.settled" }]);
    turn.notEvent("turn.settled", { data: { outcome: "failed" } });
    turn.notEvent("session.ended", { data: { outcome: "failed" } });

    const next = await session.send("WORKFLOW-IDLE-PING");
    next.expectOk();
    next.messageIncludes("WORKFLOW-IDLE");
  },
});
