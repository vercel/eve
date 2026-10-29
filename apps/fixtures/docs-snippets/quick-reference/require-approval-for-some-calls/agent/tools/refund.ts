import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Refund an order.",
  inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
  approval: ({ toolInput }) => {
    if (toolInput === undefined) return { type: "denied", reason: "Missing input." };
    return toolInput.amount >= 500 ? "user-approval" : "not-applicable";
  },
  async execute({ orderId, amount }) {
    return { orderId, refunded: amount };
  },
});
