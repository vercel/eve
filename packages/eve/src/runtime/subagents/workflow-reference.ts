import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

export const SUBAGENT_TOOL_EXECUTE_WORKFLOW_NAME = "subagentToolExecuteWorkflow";

/** Shared framework-owned execute body for local and remote subagent tools. */
export const subagentToolExecuteWorkflowReference = {
  workflowId: `workflow//${EVE_PACKAGE_NAME}//${SUBAGENT_TOOL_EXECUTE_WORKFLOW_NAME}`,
};
