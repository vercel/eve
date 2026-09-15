import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description:
    "Calculate an order subtotal and percentage discount in cents without placing or charging an order.",
  inputSchema: z.object({
    items: z
      .array(
        z.object({
          sku: z.string().min(1).max(64),
          unitPriceCents: z.number().int().min(0).max(1000000),
          quantity: z.number().int().min(1).max(100),
        }),
      )
      .max(100),
    discountBps: z.number().int().min(0).max(5000),
  }),
  approval: never(),
  async execute({ items, discountBps }) {
    const subtotalCents = items.reduce((total, item) => total + item.unitPriceCents, 0);
    const discountCents = Math.floor((subtotalCents * discountBps) / 10000);
    return {
      subtotalCents,
      discountCents,
      totalCents: subtotalCents - discountCents,
    };
  },
});
