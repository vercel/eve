import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A store-installed extension preserves assets from an extension-owned external dependency.",
  async test(t) {
    await t.send("Call `gizmo__gizmo_layout` and report its payload.");

    t.succeeded();
    t.calledTool("gizmo__gizmo_layout", {
      output: { payload: "zod@4.5.4" },
    });
  },
});
