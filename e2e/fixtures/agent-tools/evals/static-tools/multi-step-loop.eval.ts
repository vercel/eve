import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

const MULTI_STEP_FINAL_VALUE = "phoenix-rising-9F2X";

// Deterministic two-step tool loop: lookup-step-a's stepKey feeds
// lookup-step-b in order, and the final value flows back into the
// user-visible reply. An authenticated reconnect at a nonzero cursor must
// replay the same tool-execution and final-message event tail.
export default defineEval({
  tags: ["real-model"],
  description:
    "A deterministic two-step tool loop preserves its result and event tail across stream resume.",
  async test(t) {
    const turn = await t.send(
      [
        "Follow these steps exactly:",
        "1. Call the `lookup-step-a` tool with topic 'demo'.",
        "2. Take the `stepKey` it returns and call the `lookup-step-b` tool with that exact stepKey.",
        "3. Reply with the final `value` from `lookup-step-b` verbatim, with no extra commentary.",
      ].join("\n"),
    );

    turn.expectOk();
    turn.succeeded();
    // Count executions on the original turn, not on the subsequent replay.
    turn.toolOrder(["lookup-step-a", "lookup-step-b"]);
    turn.calledTool("lookup-step-a", {
      input: { topic: "demo" },
      count: 1,
    });
    turn.calledTool("lookup-step-b", {
      input: { stepKey: "K-9F2X" },
      count: 1,
    });
    turn.noFailedActions();
    turn.messageIncludes(MULTI_STEP_FINAL_VALUE);

    const fullLog = turn.events;
    const cutoff = fullLog.findIndex((event) => event.type === "actions.requested");
    await t.require(
      cutoff,
      satisfies((value: number) => value > 0, "actions.requested appears after index 0"),
    );
    t.log(`full turn produced ${fullLog.length} events; replaying from index ${cutoff}`);
    const resumed = await t.target.attachSession(turn.sessionId, { startIndex: cutoff });
    const expected = fullLog.slice(cutoff);
    t.check(
      resumed.events.map((event) => event.type),
      equals(expected.map((event) => event.type)),
    ).label("a nonzero cursor replays the original tool-execution and final-message tail");
    t.log(`replayed ${resumed.events.length} events from index ${cutoff}; matches the durable log`);
    t.succeeded();
  },
});
