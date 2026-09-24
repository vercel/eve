import { defineEval } from "eve/evals";

export default defineEval({
  description: "Parallel child agents select models from their own prompts and isolated state.",
  async test(t) {
    const turn = await t.send("Alice and Bob need parallel investigations assigned to the worker.");
    turn.expectOk();
    // Both children run in the same model step and report back inside this turn.
    turn.calledSubagent("worker", { status: "completed", count: 2 });
    turn.messageIncludes("child-result:openai/large:1");
    turn.messageIncludes("child-result:openai/small:1");
  },
});
