import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Search Alice's Slack direct messages.",
  inputSchema: z.object({ query: z.string() }),
  tags: ["reads:personal"],
  async execute() {
    return { messages: [{ from: "Bob", text: "Can you cover my on-call shift on Friday?" }] };
  },
});
