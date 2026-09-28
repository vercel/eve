import { defineJsonSchema } from "#tools/schema.js";

export { executeAgentRouterTool } from "#execution/tools/agent-router-workflow.js";

export const AGENT_ROUTER_TOOL_DESCRIPTION =
  "Route a task to the best available subagent based on each subagent's declared description.";

export interface AgentRouterInput {
  readonly message: string;
}

export const AGENT_ROUTER_INPUT_SCHEMA = defineJsonSchema<AgentRouterInput>({
  type: "object",
  properties: {
    message: {
      type: "string",
      minLength: 1,
      description: "The complete task to send to the selected agent.",
    },
  },
  required: ["message"],
  additionalProperties: false,
});
