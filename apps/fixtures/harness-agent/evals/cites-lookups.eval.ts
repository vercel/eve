import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description: "The harness adds plan_lookup, and its note makes the answer cite the lookup.",
  async test(t) {
    const turn = await t.send("Alice wants to know how many seats the enterprise plan includes.");

    turn.expectOk();
    turn.calledTool("plan_lookup", { count: 1 });
    // The model may cite unasked; the note makes sure it does.
    turn.messageIncludes(/\[\d+\]/);
    t.succeeded();
    t.noFailedCalls();
  },
});
