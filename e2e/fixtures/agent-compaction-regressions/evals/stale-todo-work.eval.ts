import { defineEval } from "eve/evals";

import { SECOND_CHECKPOINT_MARKER } from "../constants";

export default defineEval({
  tags: ["real-model"],
  description: "Source analysis completes across compaction despite a stale pending todo.",
  async test(t) {
    const turn = await t.send(
      [
        "[case: stale-todo-work]",
        "Alice and Bob are reviewing a small reading-list application for their library.",
        "Alice needs one source review. Please prepare her findings with perform-source-analysis using approach initial.",
        "Bob updates their shared checklist separately, so it may still say pending after Alice's review is complete.",
        "Please use advance-checkpoint to record the handoff from those completed findings. Include SOURCE_ANALYSIS_COMPLETE and the returned checkpoint marker in the final report so Alice and Bob can find both records.",
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
