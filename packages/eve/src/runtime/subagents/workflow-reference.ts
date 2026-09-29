import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import type { PreparedToolHandling } from "#tools/behavior.js";

export const AGENT_TOOL_SERVE_WORKFLOW_NAME = "agentToolServeWorkflow";

/** The framework-owned `serve` body of every agent tool. */
export const agentToolServeWorkflowReference = {
  workflowId: `workflow//${EVE_PACKAGE_NAME}//${AGENT_TOOL_SERVE_WORKFLOW_NAME}`,
};

/** Registered workflow that runs a tool with this handling; absent for tools without one. */
export function workflowIdForHandling(
  handling: PreparedToolHandling | undefined,
): string | undefined {
  if (handling?.kind !== "dispatch") return undefined;
  switch (handling.target.kind) {
    case "workflow-tool-call":
      return handling.target.workflowId;
    case "remote-agent-call":
    case "self-agent-call":
    case "subagent-call":
      return agentToolServeWorkflowReference.workflowId;
  }
}
