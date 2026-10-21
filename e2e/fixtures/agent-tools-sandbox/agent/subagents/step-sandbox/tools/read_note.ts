import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Reads the prepared note from the session's sandbox.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    return await sandbox.readTextFile({ path: "/workspace/step-note.txt" });
  },
});
