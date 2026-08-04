import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  tags: ["real-model"],
  description: "Cancel a parent turn and cascade cancellation to its local sleeper subagent.",
  timeoutMs: 240_000,

  async test(t) {
    // Explicit directive phrasing keeps the delegation deterministic so a
    // scripted mock responder can drive this eval in the world suites.
    const parent = await t.start(
      "Use the sleeper subagent exactly once with message 'Call the wait-for-cancellation tool exactly once and wait until this delegated turn is cancelled.'",
    );
    const called = await parent.waitForEvent("subagent.called", {
      data: { name: "sleeper" },
    });

    const child = t.target.watchTurn(called.data.childSessionId);
    await child.waitForEvent("actions.requested", {
      data: {
        actions: (actions) =>
          actions.some(
            (action) => action.kind === "tool-call" && action.toolName === "wait-for-cancellation",
          ),
      },
    });

    const cancelled = await parent.cancel();
    await t.require(
      cancelled,
      satisfies(
        (value: typeof cancelled) => value.status === "accepted",
        "parent cancel request is accepted",
      ),
    );

    const [parentTurn, childTurn] = await Promise.all([parent.result(), child.result()]);
    childTurn.event("turn.cancelled", { count: 1 });
    childTurn.eventOrder([{ type: "turn.cancelled" }, { type: "session.waiting" }]);
    childTurn.notEvent("turn.failed");
    childTurn.notEvent("session.failed");

    parentTurn.event("turn.cancelled", { count: 1 });
    parentTurn.eventOrder([{ type: "turn.cancelled" }, { type: "session.waiting" }]);
    parentTurn.notEvent("subagent.completed");
    parentTurn.notEvent("turn.failed");
    parentTurn.notEvent("session.failed");

    const followUp = await t.send({
      message: "Reply with exactly CANCELLATION-SUBAGENT-FOLLOW-UP-OK.",
    });
    followUp.expectOk();
    followUp.notEvent("turn.cancelled");
    followUp.messageIncludes(/CANCELLATION-SUBAGENT-FOLLOW-UP-OK/i);

    // The cancelled child must survive in the parent's model-visible
    // [Agents] listing as a parked "(cancelled)" handle. A handle leaked as
    // `running` never re-enters the listing, so this catches the abandoned
    // cancelled batch regressing to a permanent leak.
    const listing = await t.send(
      "Look at the [Agents] listing in your context and reply with the sleeper agent's entry verbatim, including its status.",
    );
    listing.expectOk();
    listing.notEvent("turn.cancelled");
    listing.messageIncludes(/sleeper/i);
    listing.messageIncludes(/\(cancelled\)/);

    t.event("turn.cancelled", { count: 2 });
  },
});
