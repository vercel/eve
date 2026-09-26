import {
  defineWorkflowTool,
  type WorkflowAgentMetadata,
  type WorkflowToolContext,
  type WorkflowToolDefinition,
} from "eve/tools";

async function execute(ctx: WorkflowToolContext): Promise<Record<string, WorkflowAgentMetadata>> {
  "use workflow";

  return ctx.agents;
}

const tool: WorkflowToolDefinition<
  Record<string, unknown>,
  Record<string, WorkflowAgentMetadata>
> = defineWorkflowTool({
  description: "Return the workflow's available agent metadata.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  execute,
});

export default tool;
