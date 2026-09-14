import { defineEval } from "eve/evals";

import { SECOND_CHECKPOINT_MARKER } from "../constants";

export default defineEval({
  tags: ["real-model"],
  description: "Repository inspection reaches its final result across repeated compaction.",
  async test(t) {
    const turn = await t.send(
      [
        "[case: redundant-tool-calls]",
        "Alice is reviewing a small reading-list application for the library and preparing a handoff for Bob.",
        "Please complete one review with inspect-repository using scope repository, then use advance-checkpoint to record the handoff notes.",
        "Use the completed findings for the handoff. Include REPOSITORY_INSPECTION_COMPLETE and the returned checkpoint marker in the final report so Alice and Bob can find both records.",
      ].join("\n"),
    );

    turn.expectOk();
    t.succeeded();
    t.calledTool("inspect-repository", {
      input: { scope: "repository" },
      output: { completed: true, completionMarker: "REPOSITORY_INSPECTION_COMPLETE" },
    });
    t.calledTool("advance-checkpoint", {
      output: { checkpointMarker: SECOND_CHECKPOINT_MARKER, completed: true },
    });
    t.event("compaction.completed", { count: (count) => count >= 2 });
    t.messageIncludes("REPOSITORY_INSPECTION_COMPLETE");
    t.messageIncludes(SECOND_CHECKPOINT_MARKER);
    t.noFailedActions();

    t.calledTool("inspect-repository", { count: 1 }).soft().label("no repeated inspection");
    t.calledTool("advance-checkpoint", { count: 1 }).soft().label("no repeated checkpoint");
    t.event("compaction.completed", { count: 2 }).soft().label("compaction efficiency");
  },
});
