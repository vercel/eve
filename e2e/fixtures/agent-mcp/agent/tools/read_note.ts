import { defineTool } from "eve/tools";
import { z } from "zod";

import { NOTE_PATH } from "../../fixture";

export default defineTool({
  description: "Read the note the previous shift left in the sandbox workspace.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    // `write_note` writes through the file API; reading through the shell
    // proves both resolve the relative path from the same workspace root.
    const result = await sandbox.run({ command: `cat ${NOTE_PATH}` });
    if (result.exitCode !== 0) throw new Error(`Reading the note failed: ${result.stderr}`);
    return { text: result.stdout };
  },
});
