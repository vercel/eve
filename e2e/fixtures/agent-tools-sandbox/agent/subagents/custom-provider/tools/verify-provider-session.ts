import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Reads the marker initialized through the custom provider session method.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    return await sandbox.readTextFile({ path: "/workspace/probe.txt" });
  },
});
