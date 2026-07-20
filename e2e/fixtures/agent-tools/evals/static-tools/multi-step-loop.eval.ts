import { defineEval } from "eve/evals";

const MULTI_STEP_FINAL_VALUE = "phoenix-rising-9F2X";

// Deterministic two-step tool loop: lookup-step-a's stepKey feeds
// lookup-step-b in order, and the final value flows back into the
// user-visible reply.
export default defineEval({
  description: "Static tools smoke: deterministic two-step tool loop.",
  async test(t) {
    await t.send(
      [
        "Follow these steps exactly:",
        "1. Call the `lookup-step-a` tool with topic 'demo'.",
        "2. Take the `stepKey` it returns and call the `lookup-step-b` tool with that exact stepKey.",
        "3. Reply with the final `value` from `lookup-step-b` verbatim, with no extra commentary.",
      ].join("\n"),
    );

    t.succeeded();
    t.toolOrder(["lookup-step-a", "lookup-step-b"]);
    t.calledTool("lookup-step-a", {
      input: { topic: "demo" },
      count: 1,
    });
    t.calledTool("lookup-step-b", {
      input: { stepKey: "K-9F2X" },
      count: 1,
    });
    t.noFailedActions();
    t.messageIncludes(MULTI_STEP_FINAL_VALUE);
  },
});
