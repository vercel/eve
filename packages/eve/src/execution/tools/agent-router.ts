import { z } from "#compiled/zod/index.js";
import type { JsonObject } from "#shared/json.js";

export { executeAgentRouterTool } from "#execution/tools/agent-router-workflow.js";

export const AGENT_ROUTER_TOOL_DESCRIPTION =
  "Route a task to the best available subagent based on each subagent's declared description.";

export interface AgentRouterInput {
  readonly message: string;
  readonly outputSchema?: JsonObject;
}

export const AGENT_ROUTER_INPUT_SCHEMA: z.ZodType<AgentRouterInput> = z.strictObject({
  message: z.string().min(1).describe("The complete task to send to the selected agent."),
  outputSchema: z
    .record(z.string(), z.json())
    .describe("Optional JSON Schema the selected agent's output must match.")
    .optional(),
});
