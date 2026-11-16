import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "eve/tools";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";

export default defineTool({
  description: "Hold an active fixture tool until the parent cancels it.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const directory = join(".eve", "fixture-tool", ctx.session.id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "started"), "");
    try {
      await setTimeout(60_000, undefined, { signal: ctx.abortSignal });
    } catch (error) {
      if (ctx.abortSignal.aborted)
        await writeFile(join(directory, "aborted"), "");
      throw error;
    }
    throw new Error("Fixture work was not cancelled before its deadline.");
  },
});
