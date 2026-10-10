import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Refund a paid invoice in full.",
  deferred: true,
  inputSchema: z.strictObject({ invoiceId: z.string() }),
  async execute({ invoiceId }) {
    return { invoiceId, refunded: true };
  },
});
