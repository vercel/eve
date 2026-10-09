import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Apply a percentage discount to a customer's next invoice.",
  deferred: true,
  inputSchema: z.strictObject({ customer: z.string(), percent: z.number() }),
  async execute({ customer, percent }) {
    return { applied: true, customer, percent };
  },
});
