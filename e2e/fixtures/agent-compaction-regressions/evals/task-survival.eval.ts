import { defineEval } from "eve/evals";

import { TASK_PRESERVED_MARKER, TASK_TAIL_SENTINEL } from "../constants";

export default defineEval({
  description: "The verbatim task text survives compaction and reaches the model.",
  async test(t) {
    const turn = await t.send(
      [
        "[case: task-survival]",
        "Call inspect-repository once to generate context pressure, then confirm the task.",
        // Long enough that a summarizer input cap would destroy the tail
        // sentinel; the mock only reports success when it sees the sentinel
        // verbatim in a user message after a compaction.
        `Requirements: ${"handle the edge case precisely as specified. ".repeat(30)}${TASK_TAIL_SENTINEL}`,
      ].join("\n"),
    );

    turn.expectOk();
    t.succeeded();
    t.calledTool("inspect-repository", { count: 1 });
    t.messageIncludes(TASK_PRESERVED_MARKER);
  },
});
