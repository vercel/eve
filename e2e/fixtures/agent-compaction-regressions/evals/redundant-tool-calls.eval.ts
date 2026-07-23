import { defineEval } from "eve/evals";

import { SECOND_CHECKPOINT_MARKER } from "../constants";

export default defineEval({
  description: "The model does not repeat an identical successful call after compaction.",
  async test(t) {
    const turn = await t.send(
      [
        "[case: redundant-tool-calls]",
        "Call inspect-repository exactly once with scope repository.",
        "After it succeeds, report REPOSITORY_INSPECTION_COMPLETE and call no more tools.",
      ].join("\n"),
    );

    turn.expectOk();
    t.succeeded();
    t.calledTool("inspect-repository", {
      count: 1,
      input: { scope: "repository" },
      output: { completed: true, completionMarker: "REPOSITORY_INSPECTION_COMPLETE" },
    });
    t.calledTool("advance-checkpoint", {
      count: 1,
      output: { checkpointMarker: SECOND_CHECKPOINT_MARKER, completed: true },
    });
    t.event("compaction.completed", { count: 2 });
    t.messageIncludes("REPOSITORY_INSPECTION_COMPLETE");
    t.messageIncludes(SECOND_CHECKPOINT_MARKER);
  },
});
