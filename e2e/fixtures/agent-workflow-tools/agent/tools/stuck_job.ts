import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

/**
 * A background job that never finishes on its own: its 3-second time limit
 * stops it, and the model hears about the timeout in a result turn.
 */
export default defineWorkflowTool({
  description: "Start a nightly export job in the background.",
  inputSchema: z.strictObject({}),
  detach: true,
  timeout: 3_000,
  async execute() {
    "use workflow";

    await sleep("10m");
    return { exported: true };
  },
});
