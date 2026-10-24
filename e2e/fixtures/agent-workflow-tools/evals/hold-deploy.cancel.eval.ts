import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { activeTurn, waiting } from "eve/events";

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
    const requested = await live.waitForEvent("call.requested", {
      data: { capability: { name: "hold_deploy" } },
    });
    await live.waitForEvent("call.started", {
      data: { callId: requested.data.callId, workflow: true },
    });
    const open = activeTurn(live.view);
    const wait = open === undefined ? undefined : waiting(live.view, open.turnId);
    await t.require(
      wait,
      satisfies(
        (value: typeof wait) => value?.on === "work",
        "the turn waits on the workflow call",
      ),
    );

    const cancelled = await live.cancel();
    await t.require(
      cancelled,
      satisfies(
        (value: typeof cancelled) => typeof value.deliveryId === "string",
        "cancel request is accepted",
      ),
    );

    const turn = await live.result();
    turn.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });
    t.event("turn.settled", {
      count: 1,
      data: { cause: { deliveryId: cancelled.deliveryId }, outcome: "cancelled" },
    });
    t.event("delivery.settled", {
      count: 1,
      data: { deliveryId: cancelled.deliveryId, outcome: "applied" },
    });
    t.notEvent("delivery.settled", {
      data: { deliveryId: cancelled.deliveryId, outcome: "ignored" },
    });
    turn.eventOrder([{ data: { outcome: "cancelled" }, type: "turn.settled" }]);
    turn.notEvent("turn.settled", { data: { outcome: "failed" } });
    turn.notEvent("session.ended", { data: { outcome: "failed" } });

    const next = await session.send("WORKFLOW-IDLE-PING");
    next.expectOk();
    next.messageIncludes("WORKFLOW-IDLE");
  },
});
