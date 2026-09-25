import { defineEval } from "eve/evals";

import { CONTENT_OUTPUT_UNCOMPACTED_MARKER } from "../constants";

// Inline file bytes are multimodal input, not text budget. This case verifies
// that an image-like content output reaches the next model step without
// triggering compaction. The model reports CONTENT_OUTPUT_UNCOMPACTED_MARKER
// only when the raw-payload canary remains present in the tool result.
const EXPECTED_HISTORY =
  "HISTORY<1: system > user:task ;; " +
  "2: system > user:task > assistant:tool-call > tool:result>";

export default defineEval({
  tags: ["real-model"],
  description:
    "An inline file content part does not trigger compaction from its serialized byte length.",
  async test(t) {
    const turn = await t.send(
      [
        "[case: content-output-file-stub]",
        "Alice is preparing a reading-list handoff for Bob. Please collect one review note and its attachment with emit-compaction-content.",
        "Confirm that the completed note and its attachment reference are still available.",
      ].join("\n"),
    );

    turn.expectOk();
    t.succeeded();
    t.calledTool("emit-compaction-content", {
      count: 1,
      input: {},
      output: { completed: true },
    });
    t.event("compaction.completed", { count: 0 });
    t.messageIncludes(CONTENT_OUTPUT_UNCOMPACTED_MARKER);
    t.messageIncludes(EXPECTED_HISTORY);
  },
});
