import { z } from "zod";
import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Count entries in the sandbox working directory.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    const result = await sandbox.run({ command: "ls -1 | wc -l" });
    return { count: Number(result.stdout.trim()), sessionId: ctx.session.id };
  },
});
