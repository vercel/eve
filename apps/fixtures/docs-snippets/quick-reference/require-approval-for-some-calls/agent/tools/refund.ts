import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Refund an order.",
  inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
  // toolInput is undefined when the model's input doesn't parse, so ask a person.
  approval: ({ toolInput }) =>
    toolInput === undefined || toolInput.amount >= 500 ? "user-approval" : "not-applicable",
  async execute({ orderId, amount }) {
    return { orderId, refunded: amount };
  },
});
