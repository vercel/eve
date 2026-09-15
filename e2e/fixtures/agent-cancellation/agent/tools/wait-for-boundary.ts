import { setTimeout } from "node:timers/promises";
import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description:
    "Complete a brief operation before processing Alice's next update. Call only when explicitly requested.",
  inputSchema: z.object({}),
  approval: never(),
  async execute(_input, ctx) {
    await setTimeout(2_000, undefined, { signal: ctx.abortSignal });
    return "The operation completed; process any new update now.";
  },
});
