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
    const started = await parent.waitForEvent("child.opened", {
      data: { name: "sleeper" },
    });

    const child = t.target.watchTurn(started.data.sessionId);
    await child.waitForEvent("call.requested", {
      data: { capability: { name: "wait-for-cancellation" } },
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
    childTurn.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });
    childTurn.eventOrder([{ data: { outcome: "cancelled" }, type: "turn.settled" }]);
    childTurn.notEvent("turn.settled", { data: { outcome: "failed" } });
    childTurn.notEvent("session.ended", { data: { outcome: "failed" } });

    parentTurn.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });
    parentTurn.eventOrder([{ data: { outcome: "cancelled" }, type: "turn.settled" }]);
    parentTurn.notEvent("turn.settled", { data: { outcome: "failed" } });
    parentTurn.notEvent("session.ended", { data: { outcome: "failed" } });

    const followUp = await session.send("Reply with exactly CANCELLATION-SUBAGENT-FOLLOW-UP-OK.");
    followUp.expectOk();
    followUp.notEvent("turn.settled", { data: { outcome: "cancelled" } });
    followUp.messageIncludes(/CANCELLATION-SUBAGENT-FOLLOW-UP-OK/i);

    // The eval watches both the parent and the sleeper session; each one's turn is cancelled once.
    t.event("turn.settled", { count: 2, data: { outcome: "cancelled" } });
    t.event("child.opened", { count: 1, data: { name: "sleeper" } });
    t.event("call.settled", {
      count: 1,
      data: { outcome: "interrupted" },
      scope: { taskId: /./u },
    });
  },
});
