import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

export const CODE_MODE_WORKFLOW_NAME = "codeModeWorkflow";

/** Framework-owned durable body behind the `code_mode` tool. */
export const codeModeWorkflowReference = {
  workflowId: `workflow//${EVE_PACKAGE_NAME}//${CODE_MODE_WORKFLOW_NAME}`,
};
