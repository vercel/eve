import {
  AGENT_TOOL_DESCRIPTION,
  SUBAGENT_TOOL_INPUT_SCHEMA,
} from "#tools/framework/agent-contract.js";
import { defineNativeTool } from "#tools/native-definition.js";

export const agent = defineNativeTool(
  {
    description: AGENT_TOOL_DESCRIPTION,
    inputSchema: SUBAGENT_TOOL_INPUT_SCHEMA,
  },
  {
    availability: ["root-session"],
    handling: { action: "self-agent", kind: "dispatch" },
  },
);

export default agent;
