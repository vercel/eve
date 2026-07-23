import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Search with gizmo. Returns a deterministic fixture result. Call when asked to search.",
  inputSchema: z.object({ query: z.string() }),
  async execute({ query }) {
    return { query, result: `gizmo-result-for:${query}` };
  },
});
