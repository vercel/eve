import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

/** A deferred background workflow tool: each call starts a task and returns its receipt. */
export default defineWorkflowTool({
  description: "Research a billing topic in the background and report the findings.",
  deferred: true,
  inputSchema: z.strictObject({ topic: z.string() }),
  async task({ topic }) {
    "use workflow";

    return `RESEARCH-FINDINGS:${topic}`;
  },
});
