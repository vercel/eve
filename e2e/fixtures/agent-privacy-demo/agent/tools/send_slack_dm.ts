import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Send a Slack direct message to the user you're helping.",
  inputSchema: z.object({ text: z.string() }),
  tags: ["effect:external", "sink:user"],
  async execute() {
    return { ok: true };
  },
});
