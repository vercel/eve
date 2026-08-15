import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { todo } from "eve/tools/defaults";
import { z } from "zod";

const completionMarker = "SOURCE_ANALYSIS_COMPLETE";
const invocationCount = defineState("compaction-regression.perform-source-analysis", () => 0);

export default defineTool({
  description:
    "Compaction regression tool. Complete source analysis exactly once when the user requests the stale-todo-work case.",
  inputSchema: z.object({
    approach: z.string().min(1),
  }),
  async execute(input, ctx) {
    const attempt = invocationCount.get() + 1;
    invocationCount.update(() => attempt);
    await todo.execute(
      {
        todos: [{ content: "Complete source analysis", priority: "high", status: "pending" }],
      },
      ctx,
    );

    return {
      completed: true,
      completionMarker,
      workUnit: "source-analysis",
      hardStop: attempt >= 10,
      attempt,
      approach: input.approach,
      evidencePadding: "source analysis evidence ".repeat(100),
    };
  },
});
