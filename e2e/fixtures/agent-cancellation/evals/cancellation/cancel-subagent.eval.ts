import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const RECOVERY_TOKEN = "CANCELLED-SUBAGENT-RECOVERED";

export default defineEval({
  tags: ["real-model"],
  description:
    "Cancel a parent turn, cascade cancellation to its local sleeper subagent, then resume that child.",
  timeoutMs: 240_000,

  async test(t) {
    // Explicit directive phrasing keeps the delegation deterministic so a
    // scripted mock responder can drive this eval in the world suites.
    const parent = await t.start(
      "Use the Workflow tool exactly once to call the sleeper subagent with message 'Call the wait-for-cancellation tool exactly once and wait until this delegated turn is cancelled.' Return the sleeper result.",
    );
    const called = await parent.waitForEvent("subagent.called", {
      data: { name: "sleeper" },
    });
    const agentId = called.data.agentId;
    if (agentId === undefined) throw new Error("Cancelled sleeper call has no agent id.");

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

    const resumed = await t.send(
      [
        "Use the Workflow tool exactly once.",
        `In its JavaScript, call sleeper with agentId ${JSON.stringify(agentId)} and message ${JSON.stringify(RECOVERY_TOKEN)}.`,
        "Return the inline result and reply with it verbatim. Do not call sleeper outside Workflow.",
      ].join(" "),
    );
    resumed.expectOk();
    resumed.messageIncludes(RECOVERY_TOKEN);
    resumed.event("subagent.called", {
      count: 1,
      data: {
        agentId,
        childSessionId: called.data.childSessionId,
        name: "sleeper",
      },
    });

    t.event("turn.cancelled", { count: 2 });
    t.event("subagent.called", { count: 2, data: { name: "sleeper" } });
  },
});
