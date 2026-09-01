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
    execute() {
      "use workflow";
      throw new Error(
        "The framework agent tool executes through its shared workflow registration.",
      );
    },
  }),
  { availability: ["root-session"], handling: { action: "self-agent", kind: "dispatch" } },
);

export default agent;
