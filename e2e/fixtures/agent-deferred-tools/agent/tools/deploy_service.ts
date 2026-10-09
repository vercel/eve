import { defineWorkflowTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

/** A deferred workflow tool that asks for approval; its turn parks until the run returns. */
export default defineWorkflowTool({
  description: "Deploy the billing service after a person approves it.",
  deferred: true,
  approval: always(),
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";

    return { deployed: service, tool: ctx.toolName };
  },
});
