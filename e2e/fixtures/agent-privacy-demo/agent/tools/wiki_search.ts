import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Search the company wiki.",
  inputSchema: z.object({ query: z.string() }),
  tags: ["reads:sensitive"],
  async execute() {
    return {
      pages: [{ title: "Q3 plan", text: "Revenue target: $4.2M. Launch moves to Friday." }],
    };
  },
});
