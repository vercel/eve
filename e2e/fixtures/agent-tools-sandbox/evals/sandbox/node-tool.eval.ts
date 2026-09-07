import { defineEval } from "eve/evals";

// The `run_node` authored tool gets a live sandbox via `ctx.getSandbox()`,
// writes a generated script with `writeTextFile`, and executes it with `run`.
export default defineEval({
  tags: ["real-model"],
  description: "Sandbox: an authored tool runs Node via ctx.getSandbox().",
  async test(t) {
    await t.send(
      "Use the `run_node` tool to compute the sum of these integers: 2, 3, and 4. " +
        "Reply with just the resulting number.",
    );

    t.succeeded();
    t.calledTool("run_node", {
      input: { numbers: [2, 3, 4] },
      output: { sum: 9 },
    });
    t.messageIncludes(/\b9\b/);
  },
});
