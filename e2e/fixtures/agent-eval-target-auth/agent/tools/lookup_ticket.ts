import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Look up a support ticket and return its status marker.",
  inputSchema: z.object({ id: z.string() }),
  execute: () => ({ marker: "LIVE-TICKET" }),
});
