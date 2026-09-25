import type { JsonObject } from "#shared/json.js";
import { defineJsonSchema } from "#tools/schema.js";

export { executeAgentRouterTool } from "#execution/tools/agent-router-workflow.js";

export const AGENT_ROUTER_TOOL_DESCRIPTION =
  "Route a task to the best available subagent based on each subagent's declared description.";

export interface AgentRouterInput {
  readonly message: string;
  readonly outputSchema?: JsonObject;
}

export const AGENT_ROUTER_INPUT_SCHEMA = defineJsonSchema<AgentRouterInput>({
  type: "object",
  properties: {
    message: {
      type: "string",
      minLength: 1,
      description: "The complete task to send to the selected agent.",
    },
    outputSchema: {
      type: "object",
      description:
        "Only provide a non-empty JSON Schema when the caller explicitly requests structured output; otherwise omit this field. The selected agent must match a provided schema, and that structured output becomes the tool result.",
    },
  },
  required: ["message"],
  additionalProperties: false,
});
