import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { todo } from "eve/tools/defaults";
import { z } from "zod";

const completionMarker = "SOURCE_ANALYSIS_COMPLETE";
const invocationCount = defineState("compaction-regression.perform-source-analysis", () => 0);
const modelFamilySchema = z.enum(["gpt-5.6", "opus-4.8", "sonnet-5"]);

export default defineTool({
  description:
    "Compaction regression tool. Complete source analysis exactly once when the user requests the stale-todo-work case.",
  inputSchema: z.object({
    approach: z.string().min(1),
    modelFamily: modelFamilySchema,
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
      modelFamily: input.modelFamily,
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
