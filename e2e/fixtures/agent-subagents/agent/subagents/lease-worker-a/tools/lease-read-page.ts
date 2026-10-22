import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Reads one survey page.",
  inputSchema: z.object({ page: z.number(), slow: z.boolean().optional() }),
  execute({ page }) {
    return { page, text: `Survey page ${String(page)}.` };
  },
});
