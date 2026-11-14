import { defineWorkflowTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { sleep } from "eve/workflow";
import { z } from "zod";

/**
 * Holds the turn on a durable wait, so another person's message has a call to
 * interrupt. A steering message ends the wait at once; the bound only keeps a
 * turn from waiting forever.
 */
export default defineWorkflowTool({
  description: "Finish a slow status step. Call only when explicitly requested.",
  inputSchema: z.object({}),
  approval: never(),
  async execute(_input, ctx) {
    "use workflow";
    const stopped = new Promise<"stopped">((resolve) =>
      ctx.abortSignal.addEventListener("abort", () => resolve("stopped"), { once: true }),
    );
    await Promise.race([sleep(60_000), stopped]);
    return { done: true };
  },
});
