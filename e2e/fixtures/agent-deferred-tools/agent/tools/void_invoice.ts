import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Void an unpaid invoice so it can no longer be paid.",
  deferred: true,
  inputSchema: z.strictObject({ invoiceId: z.string() }),
  async execute({ invoiceId }) {
    return { invoiceId, voided: true };
  },
});
