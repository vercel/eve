import { defineEval } from "eve/evals";

import { SECOND_CHECKPOINT_MARKER } from "../constants";

export default defineEval({
  description: "The model does not redo completed work because a stale todo stayed pending.",
  async test(t) {
    const turn = await t.send(
      [
        "[case: stale-todo-work]",
        "Call perform-source-analysis exactly once with approach initial.",
        "The tool deliberately leaves its completed work in a pending todo.",
        "After it succeeds, report SOURCE_ANALYSIS_COMPLETE and call no more tools.",
      ].join("\n"),
    );

    turn.expectOk();
    t.succeeded();
    t.calledTool("perform-source-analysis", {
      count: 1,
      output: { completed: true, workUnit: "source-analysis" },
    });
    t.calledTool("advance-checkpoint", {
      count: 1,
      output: { checkpointMarker: SECOND_CHECKPOINT_MARKER, completed: true },
    });
    t.event("compaction.completed", { count: 2 });
    t.messageIncludes("SOURCE_ANALYSIS_COMPLETE");
    t.messageIncludes(SECOND_CHECKPOINT_MARKER);
  },
});
