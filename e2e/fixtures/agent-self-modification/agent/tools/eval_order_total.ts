import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Calculate an order total in cents without placing an order or charging a customer.",
  inputSchema: z.object({
    items: z
      .array(
        z.object({
          unitPriceCents: z.number().int().min(0).max(1000000),
          quantity: z.number().int().min(1).max(100),
        }),
      )
      .max(100),
  }),
  approval: never(),
  async execute({ items }) {
    return { totalCents: items.reduce((total, item) => total + item.unitPriceCents, 0) };
  },
});
