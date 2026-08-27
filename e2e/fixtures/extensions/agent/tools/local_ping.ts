import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "The consuming agent's own ping tool. Call when asked to ping local.",
  inputSchema: z.object({}),
  async execute() {
    return { reply: "local-ping" };
  },
});
