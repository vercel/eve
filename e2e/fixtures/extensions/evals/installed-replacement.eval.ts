import { defineEval } from "eve/evals";

export default defineEval({
  description: "The installed runtime executes the application-selected extension replacement.",
  async test(t) {
    await t.send("Call `gizmo__gizmo_search` with query 'canonical' and report its result.");

    t.succeeded();
    t.calledTool("gizmo__gizmo_search", {
      input: { query: "canonical" },
      output: { query: "canonical", result: "application-override-for:canonical" },
    });
    t.noFailedActions();
  },
});
