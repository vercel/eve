import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Look up an order by ID.",
  inputSchema: z.object({ orderId: z.string() }),
  async execute({ orderId }, ctx) {
    const response = await fetch(`https://api.example.com/orders/${encodeURIComponent(orderId)}`, {
      headers: { authorization: `Bearer ${process.env.ORDERS_TOKEN}` },
      signal: ctx.abortSignal,
    });
    if (!response.ok) throw new Error(`Orders API returned ${response.status}`);
    return response.json();
  },
});
