import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Post a message to a Slack channel.",
  inputSchema: z.object({ channel: z.string(), text: z.string() }),
  tags: ["effect:external"],
  async execute() {
    return { ok: true };
  },
});
