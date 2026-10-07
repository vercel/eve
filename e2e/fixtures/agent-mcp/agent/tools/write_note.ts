import { defineTool } from "eve/tools";
import { z } from "zod";

import { NOTE_PATH } from "../../fixture";

export default defineTool({
  description: "Leave a note for the next shift in the sandbox workspace.",
  inputSchema: z.object({ text: z.string() }),
  async execute({ text }, ctx) {
    const sandbox = await ctx.getSandbox();
    await sandbox.writeTextFile({ content: text, path: NOTE_PATH });
    return { written: text };
  },
});
