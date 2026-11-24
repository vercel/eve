import { defineTool } from "eve/tools";
import { z } from "zod";

import { CUSTOMERS, CUSTOMER_COUNT, PAGE_SIZE } from "../data.js";

export default defineTool({
  description: `One page of customer summaries, ${PAGE_SIZE} per page, pages start at 1.`,
  inputSchema: z.object({ page: z.number().int().min(1) }),
  async execute({ page }) {
    const start = (page - 1) * PAGE_SIZE;
    return {
      page,
      pages: Math.ceil(CUSTOMER_COUNT / PAGE_SIZE),
      customers: CUSTOMERS.slice(start, start + PAGE_SIZE).map(
        ({ orders: _orders, ...summary }) => summary,
      ),
    };
  },
});
