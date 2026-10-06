import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Email a payment receipt to the customer again.",
  deferred: true,
  inputSchema: z.strictObject({ invoiceId: z.string() }),
  async execute({ invoiceId }) {
    return { invoiceId, resent: true };
  },
});
