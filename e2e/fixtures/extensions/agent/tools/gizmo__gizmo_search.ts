import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Application-owned replacement for the gizmo extension search tool. Call only when explicitly requested.",
  inputSchema: z.object({ query: z.string() }),
  async execute({ query }) {
    return { query, result: `application-override-for:${query}` };
  },
});
