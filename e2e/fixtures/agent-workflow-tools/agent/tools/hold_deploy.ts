import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

/**
 * Parks the turn on a long durable sleep and rejects once the call's
 * `abortSignal` aborts. Exercises a cancel cascading into a workflow tool run,
 * and a steering message stopping a body that rejects.
 */
export default defineWorkflowTool({
  description: "Hold a deploy open until the conversation moves on.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";

    const stopped = new Promise<never>((_, reject) =>
      ctx.abortSignal.addEventListener("abort", () => reject(ctx.abortSignal.reason), {
        once: true,
      }),
    );
    await Promise.race([sleep("10m"), stopped]);
    return { held: service };
  },
});
