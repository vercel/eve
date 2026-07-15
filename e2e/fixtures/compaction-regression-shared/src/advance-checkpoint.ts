import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { SECOND_CHECKPOINT_MARKER } from "./constants";

const invocationCount = defineState("compaction-regression.advance-checkpoint", () => 0);
const modelFamilySchema = z.enum(["gpt-5.6", "opus-4.8", "sonnet-5"]);

export default defineTool({
  description:
    "Test-only second-compaction trigger tool. Records a completed fixture work unit and adds enough evidence for the harness to cross the compaction threshold again.",
  inputSchema: z.object({
    modelFamily: modelFamilySchema,
    regressionCase: z.enum(["redundant-tool-calls", "stale-todo-work"]),
  }),
  async execute(input) {
    const attempt = invocationCount.get() + 1;
    invocationCount.update(() => attempt);

    return {
      checkpointMarker: SECOND_CHECKPOINT_MARKER,
      completed: true,
      modelFamily: input.modelFamily,
      regressionCase: input.regressionCase,
      attempt,
      evidencePadding: "second checkpoint evidence ".repeat(100),
    };
  },
});
