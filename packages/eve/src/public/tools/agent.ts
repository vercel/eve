import {
  agentWithModelServeWorkflow,
  type AgentWithModelToolInput,
} from "#runtime/subagents/workflow.js";
import { agent } from "#tools/framework/agent.js";
import { frameworkTool } from "#tools/provided/framework-tool.js";
import { defineJsonSchema } from "#tools/schema.js";
import {
  defineWorkflowTool,
  type WorkflowServeToolDefinition,
} from "#tools/workflow-definition.js";

export { agent, agent as default };
export type { AgentWithModelToolInput };

export type AgentWithModelTool = WorkflowServeToolDefinition<AgentWithModelToolInput, unknown>;

const inputSchema = defineJsonSchema<AgentWithModelToolInput>({
  type: "object",
  properties: {
    message: {
      type: "string",
      description: "The message to send to the agent, with everything it needs to do the work.",
    },
    model: {
      type: "string",
      minLength: 1,
      description:
        "AI Gateway model id for a new child session. When continuing a task, use its original model.",
    },
  },
  required: ["message", "model"],
  additionalProperties: false,
});

/** Root-copy agent tool whose model-facing input selects the model for each new task. */
export const agentWithModel: AgentWithModelTool = frameworkTool(
  defineWorkflowTool({
    availableInSubagents: false,
    description: [
      "Delegate a focused subtask to a copy of yourself using the selected AI Gateway model.",
      "Each call starts a task, so start independent tasks before waiting for them.",
      "A continuation keeps its task's original model.",
      "In message, state the goal, what to return, and whether it may change files.",
    ].join(" "),
    inputSchema,
    serve: agentWithModelServeWorkflow,
  }),
);
