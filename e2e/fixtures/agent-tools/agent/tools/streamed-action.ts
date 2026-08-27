import { defineTool } from "eve/tools";
import { z } from "zod";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default defineTool({
  description:
    "Test-only tool: records when local execution begins and ends, waiting before it returns. Only call when the user explicitly asks to use `streamed-action`.",
  inputSchema: z.object({
    label: z.string(),
  }),
  async *execute(input) {
    const executionStartedAt = Date.now();
    yield { executionStartedAt, label: input.label, phase: "waiting" as const };

    await delay(500);

    yield {
      executionCompletedAt: Date.now(),
      executionStartedAt,
      label: input.label,
      phase: "complete" as const,
    };
  },
});
