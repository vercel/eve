import { DYNAMIC_WORKFLOW_NAME } from "#execution/stable-workflow-names.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

export { DYNAMIC_WORKFLOW_NAME };

/** Framework-owned durable body behind the `workflow` tool. */
export const dynamicWorkflowReference = {
  workflowId: `workflow//${EVE_PACKAGE_NAME}//${DYNAMIC_WORKFLOW_NAME}`,
};
