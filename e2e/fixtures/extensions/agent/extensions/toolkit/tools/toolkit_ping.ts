import { defineTool } from "eve/tools";
import { z } from "zod";

// Co-located override: shadows the extension's own same-named toolkit_ping.
export default defineTool({
  description: "Ping the toolkit extension. Call when asked to ping toolkit. (Consumer override.)",
  inputSchema: z.object({}),
  async execute() {
    return { reply: "consumer-override-ping" };
  },
});
