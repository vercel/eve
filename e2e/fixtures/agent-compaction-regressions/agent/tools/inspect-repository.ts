import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

const completionMarker = "REPOSITORY_INSPECTION_COMPLETE";
const invocationCount = defineState("compaction-regression.inspect-repository", () => 0);

export default defineTool({
  description:
    "Compaction regression tool. Inspect the repository exactly once when the user requests the redundant-tool-calls case.",
  inputSchema: z.object({
    scope: z.literal("repository"),
  }),
  async execute() {
    const attempt = invocationCount.get() + 1;
    invocationCount.update(() => attempt);

    return {
      completed: true,
      completionMarker,
      workUnit: "repository-inspection",
      hardStop: attempt >= 10,
      attempt,
      evidencePadding: "repository inspection evidence ".repeat(100),
    };
  },
});
