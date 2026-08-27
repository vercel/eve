import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Return the identity and focus area of this fixture agent.",
  inputSchema: z.object({}),
  execute: async () => ({
    agent: "research",
    focus: "Research summaries and source planning",
  }),
});
