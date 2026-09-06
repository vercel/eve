import { defineEval } from "eve/evals";

import { SECOND_CHECKPOINT_MARKER } from "../constants";

export default defineEval({
  tags: ["real-model"],
  description: "Source analysis completes across compaction despite a stale pending todo.",
  async test(t) {
    const turn = await t.send(
      [
        "[case: stale-todo-work]",
        "Please analyze the source with perform-source-analysis, using approach attempt-1.",
        "The tool records completed work in its result; its todo entry remains pending after completion.",
        "Use the completed analysis to record a checkpoint with advance-checkpoint, using regressionCase stale-todo-work.",
        "Use only these two tools, once each, in that order. A pending todo does not require repeating completed analysis.",
        "Finish by reporting SOURCE_ANALYSIS_COMPLETE and the checkpoint tool's marker.",
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
