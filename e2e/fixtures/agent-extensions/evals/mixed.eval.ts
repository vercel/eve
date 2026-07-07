import { defineEval } from "eve/evals";

// The consumer's own tool and a second extension's tool are both callable in
// one turn, each under its own name (local_ping is the agent's; gizmo__gizmo_search
// is namespaced by the gizmo mount).
export default defineEval({
  description: "Consumer-authored and mounted-extension tools coexist and both run in one turn.",
  async test(t) {
    await t.send(
      "First call `local_ping`, then call `gizmo__gizmo_search` with query 'eve'. Report both outputs.",
    );

    t.succeeded();
    t.calledTool("local_ping", { output: { reply: "local-ping" } });
    t.calledTool("gizmo__gizmo_search", {
      output: { query: "eve", result: "gizmo-result-for:eve" },
    });
  },
});
