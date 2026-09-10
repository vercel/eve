import { z } from "zod";

export const reportSchema = z.object({
  report: z.union([
    z.object({ paidUsdCents: z.number().int(), paidUsdOrders: z.number().int() }),
    z.object({ totalAvailableCents: z.number().int(), unavailableAccounts: z.array(z.string()) }),
  ]),
});
