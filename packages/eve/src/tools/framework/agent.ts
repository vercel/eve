import { stampToolDefinition } from "#tools/definition.js";
import {
  AGENT_TOOL_DESCRIPTION,
  SUBAGENT_TOOL_INPUT_SCHEMA,
} from "#tools/framework/agent-contract.js";
import { attachToolBehavior } from "#tools/behavior.js";

export const agent = attachToolBehavior(
  stampToolDefinition(
    {
      description: AGENT_TOOL_DESCRIPTION,
      inputSchema: SUBAGENT_TOOL_INPUT_SCHEMA,
      execute(): never {
        throw new Error(
          'The framework "agent" tool was executed directly. It must be resolved through the runtime tool registry, which dispatches it to the shared subagent workflow.',
        );
      },
    },
    "defineTool",
  ),
  { availability: ["root-session"], handling: { action: "self-agent", kind: "dispatch" } },
);

export default agent;
