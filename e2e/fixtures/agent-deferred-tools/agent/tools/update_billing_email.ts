import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Change the email address that receives a customer's invoices.",
  deferred: true,
  inputSchema: z.strictObject({ customer: z.string(), email: z.string() }),
  async execute({ customer, email }) {
    return { customer, email, updated: true };
  },
});
