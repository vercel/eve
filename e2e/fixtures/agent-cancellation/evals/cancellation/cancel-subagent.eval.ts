import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  description: "Cancel a parent turn and cascade cancellation to its local sleeper subagent.",
  timeoutMs: 240_000,

  async test(t) {
    const parent = await t.start("Delegate a cancellation wait to the sleeper subagent.");
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

    const followUp = await t.send("Reply with exactly CANCELLATION-SUBAGENT-FOLLOW-UP-OK.");
    followUp.expectOk();
    followUp.notEvent("turn.cancelled");
    followUp.messageIncludes(/CANCELLATION-SUBAGENT-FOLLOW-UP-OK/i);

    t.event("turn.cancelled", { count: 2 });
  },
});
