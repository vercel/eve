import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

/** A task that watches a canary far longer than any eval runs, so only a cancel ends it. */
export default defineWorkflowTool({
  description: "Roll out a canary for a service and watch it for an hour.",
  inputSchema: z.strictObject({ service: z.string() }),
  async task({ service }) {
    "use workflow";

    await sleep("1h");
    return { healthy: true, service };
  },
});
