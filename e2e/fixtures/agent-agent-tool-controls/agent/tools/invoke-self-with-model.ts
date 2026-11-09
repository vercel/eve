import {
  defineWorkflowTool,
  type WorkflowToolContext,
  type WorkflowToolDefinition,
} from "eve/tools";

import { CTX_AGENT_SELECTED_MODEL } from "../../constants";

async function execute(
  _input: Record<string, unknown>,
  ctx: WorkflowToolContext,
): Promise<string | null> {
  "use workflow";

  const response = await ctx
    .agent("agent", { model: CTX_AGENT_SELECTED_MODEL })
    .send("Review Alice's sample plan and reply when the review is complete.");
  const { reply } = await response.result();
  return reply ?? null;
}

const tool: WorkflowToolDefinition<Record<string, unknown>, string | null> = defineWorkflowTool({
  description: "Invoke a root copy with an authored model override.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  execute,
});

export default tool;
