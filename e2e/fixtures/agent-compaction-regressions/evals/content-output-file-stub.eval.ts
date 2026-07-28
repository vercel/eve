import { defineEval } from "eve/evals";

import { CONTENT_OUTPUT_COMPACTION_MARKER } from "../constants";

export default defineEval({
  description: "Compaction preserves text after a large inline file content part.",
  async test(t) {
    const turn = await t.send(
      [
        "[case: content-output-file-stub]",
        "Call emit-compaction-content exactly once.",
        "After compaction, report whether its completion evidence survived.",
      ].join("\n"),
    );

    turn.expectOk();
    t.succeeded();
    t.calledTool("emit-compaction-content", {
      count: 1,
      input: {},
      output: { completed: true },
    });
    t.event("compaction.completed", { count: 1 });
    t.messageIncludes(CONTENT_OUTPUT_COMPACTION_MARKER);
  },
});
