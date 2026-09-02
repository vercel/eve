import { defineTool } from "#tools/definition.js";
import {
  AGENT_TOOL_DESCRIPTION,
  SUBAGENT_TOOL_INPUT_SCHEMA,
} from "#tools/framework/agent-contract.js";
import { attachToolBehavior } from "#tools/behavior.js";

export const agent = attachToolBehavior(
  defineTool({
    description: AGENT_TOOL_DESCRIPTION,
    execution: "background",
    inputSchema: SUBAGENT_TOOL_INPUT_SCHEMA,
    // `defineTool` requires a body, but the runtime tool registry rebinds this
    // tool to the shared subagent workflow before it can ever run.
    execute() {
      "use workflow";
      throw new Error(
        'The framework "agent" tool was executed directly. It must be resolved through the runtime tool registry, which dispatches it to the shared subagent workflow.',
      );
    },
  }),
  { availability: ["root-session"], handling: { action: "self-agent", kind: "dispatch" } },
);

export default agent;
