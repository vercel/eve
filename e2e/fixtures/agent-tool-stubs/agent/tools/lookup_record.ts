import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Look up records matching a filter and return a result marker.",
  inputSchema: z.object({
    filter: z.object({ status: z.enum(["open", "closed"]), owner: z.string() }),
    query: z.string(),
    tags: z.array(z.string()),
    limit: z.number().int().positive(),
  }),
  execute: () => ({ marker: "LIVE-LOOKUP" }),
});
