import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Summarize a customer's metered usage for a month.",
  deferred: true,
  inputSchema: z.strictObject({ customer: z.string(), month: z.string() }),
  async execute({ customer, month }) {
    return { customer, month, units: 4200 };
  },
});
