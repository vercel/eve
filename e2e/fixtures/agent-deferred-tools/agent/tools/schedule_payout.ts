import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Schedule a payout of a customer's credit balance.",
  deferred: true,
  inputSchema: z.strictObject({ customer: z.string() }),
  async execute({ customer }) {
    return { customer, scheduled: true };
  },
});
