import { defineEval } from "eve/evals";

import { CONTENT_OUTPUT_COMPACTION_MARKER } from "../constants";

// Compaction handles the oversized content output with its tool-result cap
// heuristic: no summarizer call, no checkpoint — the history keeps its exact
// shape and only the file part is rewritten to a text stub in place. The
// mock task model reports CONTENT_OUTPUT_COMPACTION_MARKER only when that
// capped result honors the full contract:
// - the raw payload is gone (a canary buried in the base64 detects the cap
//   and any leak);
// - the file rendered as its `Attached file <name> (<mediaType>)` stub;
// - the text parts around the file survived in place (lead + tail markers);
// - the surrounding conversation was untouched (the case's own user text).
// On violation the model emits granular *_LOST diagnostics instead, so a
// failing run names the broken clause.
// The exact conversation shape, rendered by the mock model per request: the
// pre-compaction call sees only the task; the post-cap call sees the same
// conversation, structurally untouched — task, tool call, and tool result
// all still present, with only the result's file payload stubbed. No
// checkpoint pair appears because the cap heuristic satisfies the threshold
// without summarizing.
const EXPECTED_HISTORY =
  "HISTORY<1: system > user:task ;; " +
  "2: system > user:task > assistant:tool-call > tool:result>";

export default defineEval({
  tags: ["real-model"],
  description: "Compaction stubs a large inline file content part without losing its sibling text.",
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
    t.messageIncludes(EXPECTED_HISTORY);
  },
});
