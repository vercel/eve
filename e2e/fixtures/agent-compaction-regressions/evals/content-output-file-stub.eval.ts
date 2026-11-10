import { defineEval } from "eve/evals";

import { CONTENT_OUTPUT_COMPACTION_MARKER } from "../constants";

// Compaction summarizes the conversation once and keeps the recent tail,
// where the oversized content output survives with its file part rendered as
// a text stub. The mock task model reports CONTENT_OUTPUT_COMPACTION_MARKER
// only when that kept result honors the full contract:
// - the raw payload is gone (a canary buried in the base64 detects any leak);
// - the file rendered as its `Attached file <path> (<mediaType>)` stub;
// - the text parts around the file survived in place (lead + tail markers);
// - the case's own user text is still present.
// On violation the model emits granular *_LOST diagnostics instead, so a
// failing run names the broken clause.
// The exact conversation shape, rendered by the mock model per request: the
// pre-compaction call sees only the task; the post-compaction call sees the
// checkpoint pair, then the kept tool call and its stubbed result, then the
// task replayed as the turn to resume from.
const EXPECTED_HISTORY =
  "HISTORY<1: system > user:task ;; " +
  "2: system > user:checkpoint-marker > assistant:checkpoint > assistant:tool-call > tool:result > user:task>";

export default defineEval({
  tags: ["real-model"],
  description: "Compaction stubs a large inline file content part without losing its sibling text.",
  async test(t) {
    const turn = await t.send(
      [
        "[case: content-output-file-stub]",
        "Alice is preparing a reading-list handoff for Bob. Please collect one review note and its attachment with emit-compaction-content.",
        "After the conversation is summarized, confirm that the completed note and its attachment reference are still available.",
      ].join("\n"),
    );

    turn.expectOk();
    t.succeeded();
    t.calledTool("emit-compaction-content", {
      count: 1,
      input: {},
      output: { completed: true },
    });
    t.event("context.settled", { count: 1, data: { kind: "compaction", outcome: "completed" } });
    t.messageIncludes(CONTENT_OUTPUT_COMPACTION_MARKER);
    t.messageIncludes(EXPECTED_HISTORY);
  },
});
