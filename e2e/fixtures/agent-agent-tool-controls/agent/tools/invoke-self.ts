import {
  defineWorkflowTool,
  type WorkflowToolContext,
  type WorkflowToolDefinition,
} from "eve/tools";

async function execute(ctx: WorkflowToolContext) {
  "use workflow";

  return ctx.agent("agent", { message: "E2E_INTERNAL_ROOT_COPY" });
}

const tool: WorkflowToolDefinition<
  Record<string, unknown>,
  Awaited<ReturnType<WorkflowToolContext["agent"]>>
> = defineWorkflowTool({
  description: "Invoke an internal copy of the root agent.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  execute,
});

export default tool;
