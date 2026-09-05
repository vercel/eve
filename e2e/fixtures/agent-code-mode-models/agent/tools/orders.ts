import { defineTool } from "eve/tools";
import { z } from "zod";
import { record } from "../../src/audit";
import { dataset } from "../../src/data";

export default defineTool({
  description:
    "Read one page of the orders export. Returns { orders: [{ status, currency, cents }], nextCursor }. Status is paid or refunded; currency is an ISO code; cents is an integer. Start with no cursor, then pass the returned nextCursor to read the next page. A null nextCursor means the export is complete.",
  inputSchema: z.object({ cursor: z.string().nullish() }),
  outputSchema: z.object({
    orders: z.array(
      z.object({ status: z.string(), currency: z.string(), cents: z.number().int() }),
    ),
    nextCursor: z.string().nullable(),
  }),
  async execute(input, ctx) {
    return record(ctx, input, () => {
      const { pages } = dataset(ctx.session.id);
      const index = pages.findIndex((page) => page.cursor === (input.cursor ?? null));
      if (index < 0) throw new Error("Unknown orders cursor");
      return { orders: pages[index]!.orders, nextCursor: pages[index + 1]?.cursor ?? null };
    });
  },
});
