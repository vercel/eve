import { defineTool } from "#public/definitions/tool.js";
import { AGENT_TOOL_DESCRIPTION, SUBAGENT_TOOL_INPUT_SCHEMA } from "#shared/agent-tool.js";

/** Canonical PR 1 source definition; durable execution remains in the harness. */
export const agent = defineTool({
  description: AGENT_TOOL_DESCRIPTION,
  inputSchema: SUBAGENT_TOOL_INPUT_SCHEMA,
  execute() {
    throw new Error("agent is handled by eve's durable dispatch step.");
  },
});

export default agent;
