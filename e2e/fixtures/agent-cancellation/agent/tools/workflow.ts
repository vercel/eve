import { defineWorkflowTool, runWorkflowProgram, type WorkflowToolDefinition } from "eve/tools";

const agents = ["sleeper", "steering-worker"] as const;

const workflowTool: WorkflowToolDefinition<
  Record<string, unknown>,
  Awaited<ReturnType<typeof runWorkflowProgram>>
> = defineWorkflowTool({
  description: `Run a JavaScript function body with ctx.agent(name, input). Available agents: ${agents.join(", ")}.`,
  inputSchema: {
    properties: { js: { type: "string" } },
    required: ["js"],
    type: "object",
  },
  async execute({ js }, ctx) {
    "use workflow";
    return runWorkflowProgram(js as string, ctx, { agents });
  },
});

export default workflowTool;
