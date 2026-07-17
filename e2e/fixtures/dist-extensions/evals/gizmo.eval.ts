import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A built extension installed with a registry-style store layout loads and its tool runs.",
  async test(t) {
    await t.send("Call `gizmo__gizmo_search` with query 'eve'. Report the output.");

    t.succeeded();
    t.calledTool("gizmo__gizmo_search", {
      output: { query: "eve", result: "gizmo-result-for:eve" },
    });
  },
});
