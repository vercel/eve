import { defineTool } from "eve/tools";
import { z } from "zod";

import { NOTE_PATH } from "../../fixture";

export default defineTool({
  description: "Read the note the previous shift left in the sandbox workspace.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    return { text: await sandbox.readTextFile({ path: NOTE_PATH }) };
  },
});
