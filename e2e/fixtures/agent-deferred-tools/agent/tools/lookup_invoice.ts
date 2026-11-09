import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Look up an invoice's amount, status, and line items.",
  deferred: true,
  inputSchema: z.strictObject({ invoiceId: z.string() }),
  async execute({ invoiceId }) {
    return { amount: 120, invoiceId, status: "paid" };
  },
});
