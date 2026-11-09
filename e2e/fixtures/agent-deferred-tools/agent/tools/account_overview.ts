import { defineTool } from "eve/tools";
import { z } from "zod";

// The desk's everyday tool stays in the model's tool list; the long tail is deferred.
export default defineTool({
  description: "Show a customer's plan, balance, and open invoices.",
  inputSchema: z.strictObject({ customer: z.string() }),
  async execute({ customer }) {
    return { balance: 120, customer, openInvoices: ["INV-2041"], plan: "team" };
  },
});
