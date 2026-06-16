import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  needsApproval: never(),
  description:
    "Generate a random result: pick one of the given choices, or a random number between min and max.",
  inputSchema: z.object({
    choices: z
      .array(z.string())
      .optional()
      .describe("Options to pick one from. Takes precedence over min/max."),
    min: z.number().optional().describe("Lowest number (inclusive). Default 1."),
    max: z.number().optional().describe("Highest number (inclusive). Default 100."),
  }),
  async execute({ choices, min = 1, max = 100 }) {
    if (choices && choices.length > 0) {
      const choice = choices[Math.floor(Math.random() * choices.length)];
      return { result: choice, choices };
    }

    const result = Math.floor(Math.random() * (max - min + 1)) + min;
    return { result, min, max };
  },
});
