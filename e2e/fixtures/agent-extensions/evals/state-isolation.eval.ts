import { defineEval } from "eve/evals";

// Both extensions author defineState("budget"). eve scopes each to its own
// package namespace, so bumping toolkit's budget twice leaves gizmo's budget at
// 1 — the counters do not share one durable slot. If scoping regressed, the two
// would collapse onto one bare "budget" slot and gizmo would read 3, not 1.
export default defineEval({
  description: "Two extensions' identically-named defineState do not collide within a session.",
  async test(t) {
    await t.send(
      "Bump the toolkit budget twice by calling `toolkit__toolkit_budget` two times, then bump the gizmo budget once by calling `gizmo__gizmo_budget`. Report each tool's returned count.",
    );

    t.succeeded();
    t.calledTool("toolkit__toolkit_budget", { output: { scope: "toolkit", count: 2 } });
    t.calledTool("gizmo__gizmo_budget", { output: { scope: "gizmo", count: 1 } });
  },
});
