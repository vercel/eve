import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

import { replyFrom } from "../lib/agent-reply.ts";

export default defineWorkflowTool({
  description: "Call two workflow-owned subagents in parallel and return both inline results.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";

    return await Promise.all([
      replyFrom(ctx, "workflow-marker", `${service}:replica-0`),
      replyFrom(ctx, "workflow-marker", `${service}:replica-1`),
    ]);
  },
});
