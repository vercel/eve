import {
  defineWorkflowTool,
  type WorkflowToolContext,
  type WorkflowToolDefinition,
} from "eve/tools";

async function execute(
  _input: Record<string, unknown>,
  ctx: WorkflowToolContext,
): Promise<string | null> {
  "use workflow";

  const response = await ctx.agent("agent").send("E2E_INTERNAL_ROOT_COPY");
  const { message } = await response.result();
  return message ?? null;
}

const tool: WorkflowToolDefinition<Record<string, unknown>, string | null> = defineWorkflowTool({
  description: "Invoke an internal copy of the root agent.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  execute,
});

export default tool;
