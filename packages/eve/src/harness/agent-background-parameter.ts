import type { HarnessToolMap } from "#harness/types.js";
import { AGENT_TASK_WORKFLOW_ID } from "#tasks/agent-tool.js";
import { BACKGROUND_SUBAGENT_TOOL_INPUT_SCHEMA } from "#tools/framework/agent-contract.js";

/**
 * Gives every agent tool (declared, remote, dynamic, and the built-in
 * `agent`) the model-facing `background` parameter. Other tools are unchanged.
 */
export function withAgentBackgroundParameter(tools: HarnessToolMap): HarnessToolMap {
  const next = new Map(tools);
  for (const [name, tool] of tools) {
    if (tool.workflowId !== AGENT_TASK_WORKFLOW_ID) continue;
    next.set(name, { ...tool, inputSchema: BACKGROUND_SUBAGENT_TOOL_INPUT_SCHEMA });
  }
  return next;
}
