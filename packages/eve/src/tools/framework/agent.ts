import { defineTool } from "#tools/definition.js";
import {
  AGENT_TOOL_DESCRIPTION,
  SUBAGENT_TOOL_INPUT_SCHEMA,
} from "#tools/framework/agent-contract.js";

/** The harness intercepts this tool before its durable dispatch step executes. */
export const agent = defineTool({
  description: AGENT_TOOL_DESCRIPTION,
  inputSchema: SUBAGENT_TOOL_INPUT_SCHEMA,
  execute() {
    throw new Error("agent is handled by eve's durable dispatch step.");
  },
});

export default agent;
