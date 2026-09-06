import { defineEval } from "eve/evals";

import { TASK_PRESERVED_MARKER, TASK_TAIL_SENTINEL } from "../constants";

export default defineEval({
  tags: ["real-model"],
  description: "The verbatim task text survives compaction and reaches the model.",
  async test(t) {
    const turn = await t.send(
      [
        "[case: task-survival]",
        "Inspect the repository, then confirm the requirements for the change.",
        // Sized to a narrow window: long enough that a 280-char summarizer
        // input cap would destroy the tail sentinel, but short enough that
        // the task alone cannot cross the fixture's ~640-token threshold —
        // otherwise compaction fires before the first model call and the
        // mock never generates pressure.
        [
          "Requirements: Keep existing public entry points working.",
          "Validate empty input and malformed requests. Preserve the order of streamed events.",
          "Include the original error when reporting a failure.",
          "Keep cancellation responsive while a child runs. Document any changed return values.",
          "Cover retries without duplicating completed work.",
          TASK_TAIL_SENTINEL,
        ].join(" "),
      ].join("\n"),
    );

    turn.expectOk();
    t.succeeded();
    t.calledTool("inspect-repository");
    t.event("compaction.completed");
    t.messageIncludes(TASK_PRESERVED_MARKER);
  },
});
