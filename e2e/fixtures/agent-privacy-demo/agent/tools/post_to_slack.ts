import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Post a message to a channel in the company Slack workspace.",
  inputSchema: z.object({ channel: z.string(), text: z.string() }),
  tags: ["effect:external", "sink:internal"],
  async execute() {
    return { ok: true };
  },
});
