import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Ping the toolkit extension. Returns the extension's own reply. Call when asked to ping toolkit.",
  inputSchema: z.object({}),
  async execute() {
    return { reply: "toolkit-extension-ping" };
  },
});
