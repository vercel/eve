import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

const completionMarker = "REPOSITORY_INSPECTION_COMPLETE";
const invocationCount = defineState("compaction-regression.inspect-repository", () => 0);
const modelFamilySchema = z.enum(["gpt-5.6", "opus-4.8", "sonnet-5"]);

export default defineTool({
  description:
    "Compaction regression tool. Inspect the repository exactly once when the user requests the redundant-tool-calls case.",
  inputSchema: z.object({
    modelFamily: modelFamilySchema,
    scope: z.literal("repository"),
  }),
  async execute(input) {
    const attempt = invocationCount.get() + 1;
    invocationCount.update(() => attempt);

    return {
      modelFamily: input.modelFamily,
      completed: true,
      completionMarker,
      workUnit: "repository-inspection",
      hardStop: attempt >= 10,
      attempt,
      evidencePadding: "repository inspection evidence ".repeat(100),
    };
  },
});
