import { setTimeout } from "node:timers/promises";
import { defineTool } from "eve/tools";
import { z } from "zod";

/** Keeps the turn running for a few seconds, so a message sent meanwhile waits behind it. */
export default defineTool({
  description: "Finish a short review step. Call only when explicitly requested.",
  inputSchema: z.strictObject({}),
  async execute(_input, ctx) {
    await setTimeout(5_000, undefined, { signal: ctx.abortSignal });
    return "The review step finished.";
  },
});
