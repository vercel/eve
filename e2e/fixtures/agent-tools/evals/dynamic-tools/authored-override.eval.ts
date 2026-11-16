import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description: "Dynamic tools smoke: a static tool keeps its name when a dynamic tool collides.",
  async test(t) {
    await t.send("Call the `override-target` tool and report the `source` value it returns.");

    t.succeeded();
    t.calledTool("override-target", {
      output: { source: "authored" },
    });
  },
});
