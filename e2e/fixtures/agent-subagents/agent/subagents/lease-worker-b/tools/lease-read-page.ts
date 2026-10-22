import { defineTool } from "eve/tools";
import { z } from "zod";

import { LEASE_SLOW_PAGE_MS } from "../../../../constants.js";

export default defineTool({
  description: "Reads one survey page.",
  inputSchema: z.object({ page: z.number(), slow: z.boolean().optional() }),
  async execute({ page, slow }) {
    // The second page is slow, so worker b is still running when worker a's prompt is approved.
    if (page === 1 && slow !== false) {
      await new Promise((resolve) => setTimeout(resolve, LEASE_SLOW_PAGE_MS));
    }
    return { page, text: `Survey page ${String(page)}.` };
  },
});
