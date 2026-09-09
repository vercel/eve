import { defineEval } from "eve/evals";

import { SECOND_CHECKPOINT_MARKER } from "../constants";

export default defineEval({
  tags: ["real-model"],
  description: "Source analysis completes across compaction despite a stale pending todo.",
  async test(t) {
    const turn = await t.send(
      [
        "[case: stale-todo-work]",
        "Alice and Bob are reviewing a small catalog application.",
        "Use perform-source-analysis once with approach initial to prepare Alice's findings.",
        "Bob updates their shared checklist separately, so it may still say pending after the analysis is complete.",
        "Use the completed analysis for the handoff and include SOURCE_ANALYSIS_COMPLETE.",
        "The pending checklist entry does not require repeating the completed analysis.",
      ].join("\n"),
    );

    turn.expectOk();
    t.succeeded();
    t.calledTool("perform-source-analysis", {
      output: { completed: true, workUnit: "source-analysis" },
    });
    t.calledTool("advance-checkpoint", {
      output: { checkpointMarker: SECOND_CHECKPOINT_MARKER, completed: true },
    });
    t.event("compaction.completed", { count: (count) => count >= 2 });
    t.messageIncludes("SOURCE_ANALYSIS_COMPLETE");
    t.messageIncludes(SECOND_CHECKPOINT_MARKER);
    t.noFailedActions();

    t.calledTool("perform-source-analysis", { count: 1 }).soft().label("no repeated analysis");
    t.calledTool("advance-checkpoint", { count: 1 }).soft().label("no repeated checkpoint");
    t.event("compaction.completed", { count: 2 }).soft().label("compaction efficiency");
  },
});
