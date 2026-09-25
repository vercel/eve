import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Emit a revised change plan when the user corrects its target.",
  inputSchema: z.object({ targetUserId: z.string() }),
  async execute(input) {
    return { emitted: true, ...input };
  },
});
