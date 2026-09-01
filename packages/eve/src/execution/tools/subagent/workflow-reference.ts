import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { SUBAGENT_TOOL_EXECUTE_WORKFLOW_NAME } from "#execution/stable-workflow-names.js";

/** Shared framework-owned execute body for local and remote subagent tools. */
export const subagentToolExecuteWorkflowReference = {
  workflowId: `workflow//${resolveInstalledPackageInfo().name}//${SUBAGENT_TOOL_EXECUTE_WORKFLOW_NAME}`,
};
