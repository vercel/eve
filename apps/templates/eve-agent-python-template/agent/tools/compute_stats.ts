import { defineTool } from "eve/tools";
import { z } from "zod";
import { backendRequest } from "../lib/backend";
import { statsSchema } from "../lib/python-tools";

export default defineTool({
  description:
    "Compute descriptive statistics (count, sum, mean, median, modes, min, max, range, sample stdev, variance, quartiles) for a list of numbers. Runs in Python.",
  inputSchema: z.object({
    numbers: z.array(z.number()).min(1).max(10_000).describe("The numbers to analyze."),
  }),
  outputSchema: statsSchema,
  label: {
    start: ({ numbers }) => `Computing stats for ${numbers.length} numbers in Python`,
    complete: (_input, output) => `Computed stats (mean ${output.mean})`,
  },
  async execute({ numbers }) {
    return statsSchema.parse(await backendRequest("/tools/stats", { body: { numbers } }));
  },
});
