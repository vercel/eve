import { setTimeout } from "node:timers/promises";
import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

/** Keeps the turn running for a few seconds, so another person's message arrives mid-turn. */
export default defineTool({
  description: "Finish a short status step. Call only when explicitly requested.",
  inputSchema: z.object({}),
  approval: never(),
  async execute(_input, ctx) {
    await setTimeout(4_000, undefined, { signal: ctx.abortSignal });
    return { done: true };
  },
});
