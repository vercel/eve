import { defineEval } from "eve/evals";

import { CATALOG_HANDOFF_MARKER, CATALOG_HANDOFF_REQUEST } from "../constants";

export default defineEval({
  description:
    "Recent tool completion evidence is summarized before a larger checkpoint displaces the tool result.",
  async test(t) {
    const turn = await t.send(CATALOG_HANDOFF_REQUEST);
    turn.expectOk();
    t.succeeded();
    t.calledTool("record-catalog-handoff", {
      count: 1,
      output: { completionMarker: CATALOG_HANDOFF_MARKER, completed: true },
    });
    t.event("compaction.completed", { count: 1 });
    t.messageIncludes("RECENT_TOOL_EVIDENCE_KEPT");
    t.noFailedActions();
  },
});
