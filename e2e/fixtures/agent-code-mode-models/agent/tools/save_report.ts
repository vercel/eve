import { defineTool } from "eve/tools";
import { z } from "zod";
import { record } from "../../src/audit";

export default defineTool({
  description:
    "Save an orders or treasury report. Amounts are integer USD cents. Returns { saved: true }.",
  inputSchema: z.union([
    z.object({ paidUsdCents: z.number().int(), paidUsdOrders: z.number().int() }),
    z.object({ totalAvailableCents: z.number().int(), unavailableAccounts: z.array(z.string()) }),
  ]),
  outputSchema: z.object({ saved: z.boolean() }),
  async execute(input, ctx) {
    return record(ctx, input, () => ({ saved: true }));
  },
});
