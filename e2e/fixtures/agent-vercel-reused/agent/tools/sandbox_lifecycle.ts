import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Stops or deletes this eve session's logical sandbox view.",
  inputSchema: z.object({ operation: z.enum(["stop", "delete"]) }),
  approval: never(),
  async execute({ operation }, ctx) {
    const sandbox = await ctx.getSandbox();
    if (operation === "stop") await sandbox.stop();
    else await sandbox.delete();
    return { operation };
  },
});
