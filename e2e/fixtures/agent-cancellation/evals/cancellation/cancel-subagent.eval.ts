import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  description:
    "Cancel a parent turn and cascade cancellation to the local sleeper session its workflow run opened.",
  timeoutMs: 240_000,

  async test(t) {
    const session = await t.session();
    // Explicit directive phrasing keeps the delegation deterministic so a
    // scripted mock responder can drive this eval in the world suites.
    const parent = await session.start(
      "Use the workflow tool exactly once to call the sleeper subagent with message 'Call the wait-for-cancellation tool exactly once and wait until this delegated turn is cancelled.' Return the sleeper result.",
    );
    const started = await parent.waitForEvent("agent.started", {
      data: { name: "sleeper" },
    });

    const child = t.target.watchTurn(started.data.sessionId);
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
    parentTurn.notEvent("turn.failed");
    parentTurn.notEvent("session.failed");

    const followUp = await session.send("Reply with exactly CANCELLATION-SUBAGENT-FOLLOW-UP-OK.");
    followUp.expectOk();
    followUp.notEvent("turn.cancelled");
    followUp.messageIncludes(/CANCELLATION-SUBAGENT-FOLLOW-UP-OK/i);

    // The eval watches both the parent and the sleeper session; each one's turn is cancelled once.
    t.event("turn.cancelled", { count: 2 });
    t.event("agent.started", { count: 1, data: { name: "sleeper" } });
  },
});
