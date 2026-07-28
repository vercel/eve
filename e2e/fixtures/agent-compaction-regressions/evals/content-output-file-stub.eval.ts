import { defineEval } from "eve/evals";

import { CONTENT_OUTPUT_COMPACTION_MARKER } from "../constants";

// The mock task model reports CONTENT_OUTPUT_COMPACTION_MARKER only when the
// post-compaction checkpoint honors the full content-output contract:
// - the text parts around the file survived (lead + tail markers);
// - the file rendered as a stub (the filename exists nowhere but the stub);
// - the raw payload did not leak (a canary buried in the base64 can reach
//   the checkpoint only if the payload reached the compaction prompt);
// - the surrounding conversation was untouched (the case's own user text).
// On violation the model emits granular *_LOST / PAYLOAD_LEAKED diagnostics
// instead, so a failing run names the broken clause.
// The exact conversation shape, rendered by the mock model per request:
// the pre-compaction call sees only the task; the post-compaction call sees
// the checkpoint pair and the replayed task — the tool call and its 12KB
// result must be gone entirely, summarized rather than kept. The shape is
// deterministic: the payload can never fit the fixture's keep threshold, so
// the stripped-tail path always runs.
const EXPECTED_HISTORY =
  "HISTORY<1: system > user:task ;; " +
  "2: system > user:checkpoint-marker > assistant:checkpoint > user:task>";

export default defineEval({
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
