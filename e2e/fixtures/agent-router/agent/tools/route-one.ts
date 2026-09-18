import {
  defineWorkflowTool,
  type WorkflowToolContext,
  type WorkflowToolDefinition,
} from "eve/tools";
import { auto } from "eve/tools/agent-router";

async function execute(input: Record<string, unknown>, ctx: WorkflowToolContext) {
  "use workflow";

  if (typeof input.message !== "string") throw new Error("route-one requires a message.");
  const target = await auto({
    abortSignal: ctx.abortSignal,
    agents: { agent: ctx.agents.agent.description },
    message: input.message,
  });
  return ctx.agent(target, { message: input.message });
}

const tool: WorkflowToolDefinition<
  Record<string, unknown>,
  Awaited<ReturnType<typeof execute>>
> = defineWorkflowTool({
  description: "Route one task with the exported agent-router selection step.",
  inputSchema: {
    additionalProperties: false,
    properties: { message: { type: "string" } },
    required: ["message"],
    type: "object",
  },
  execute,
});

export default tool;
