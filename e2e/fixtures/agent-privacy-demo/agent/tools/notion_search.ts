import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Search Alice's private Notion pages.",
  inputSchema: z.object({ query: z.string() }),
  tags: ["reads:personal"],
  async execute() {
    return { pages: [{ title: "1:1 notes", text: "Alice is interviewing with another team." }] };
  },
});
