import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

import { replyFrom } from "../lib/agent-reply.ts";

export default defineWorkflowTool({
  description: "Run one subagent from a waiting workflow tool.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";

    return await replyFrom(ctx, "workflow-marker", `${service}:blocking`);
  },
});
