import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

// Dependency-free so the bundler can import it.

export const PROGRAM_AGENT_CALL_WORKFLOW_NAME = "programAgentCallWorkflow";

/** The framework-owned run of one agent call a program awaits. */
export const programAgentCallWorkflowReference = {
  workflowId: `workflow//${EVE_PACKAGE_NAME}//${PROGRAM_AGENT_CALL_WORKFLOW_NAME}`,
};
