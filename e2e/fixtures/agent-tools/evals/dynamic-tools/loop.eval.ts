import { defineEval } from "eve/evals";

// Tools generated inside a for loop keep their per-iteration closures.
export default defineEval({
  description: "Dynamic tools smoke: loop-generated tools keep per-iteration closures.",
  async test(t) {
    await t.send("Call the `alpha` tool and tell me the name and index it returned.");

    t.succeeded();
    t.calledTool("alpha", {
      output: { name: "alpha", index: 0 },
    });
  },
});
