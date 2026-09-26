import { defineWorkflowTool } from "eve/tools";

import {
  executeWorkflowAgentProbe,
  workflowAgentProbeInputSchema,
} from "../lib/workflow-agent-probe.ts";

export default defineWorkflowTool({
  description: "Run a blocking local or remote subagent HITL/authorization probe.",
  inputSchema: workflowAgentProbeInputSchema,
  async execute(ctx) {
    "use workflow";

    const { input } = await ctx.receive();
    return await executeWorkflowAgentProbe(input, ctx);
  },
});
