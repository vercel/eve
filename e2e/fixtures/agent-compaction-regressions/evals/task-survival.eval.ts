import { defineEval } from "eve/evals";

import { TASK_PRESERVED_MARKER, TASK_TAIL_SENTINEL } from "../constants";

export default defineEval({
  description: "The verbatim task text survives compaction and reaches the model.",
  async test(t) {
    const turn = await t.send(
      [
        "[case: task-survival]",
        "Call inspect-repository once to generate context pressure, then confirm the task.",
        // Sized to a narrow window: long enough that a 280-char summarizer
        // input cap would destroy the tail sentinel, but short enough that
        // the task alone cannot cross the fixture's ~640-token threshold —
        // otherwise compaction fires before the first model call and the
        // mock never generates pressure.
        `Requirements: ${"handle the edge case exactly. ".repeat(12)}${TASK_TAIL_SENTINEL}`,
      ].join("\n"),
    );

    turn.expectOk();
    t.succeeded();
    t.calledTool("inspect-repository", { count: 1 });
    t.messageIncludes(TASK_PRESERVED_MARKER);
  },
});
