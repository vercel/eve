/**
 * eve workflow functions whose bundled id carries no `@<version>` stamp, so
 * an explicitly stamped deployment can find them across eve versions.
 * Dependency-free so the bundler can import it.
 */
export const HOLDING_WORKFLOW_NAME = "holdingWorkflow";
export const TURN_WORKFLOW_NAME = "turnWorkflow";
export const SESSION_TIMEOUT_WORKFLOW_NAME = "sessionTimeoutWorkflow";
export const TASK_RUN_WORKFLOW_NAME = "taskRunWorkflow";
export const WORKFLOW_TOOL_RUN_WORKFLOW_NAME = "workflowToolRunWorkflow";
export const ACTIVITY_COLLECTOR_WORKFLOW_NAME = "activityCollectorWorkflow";

export const STABLE_WORKFLOW_NAMES: ReadonlySet<string> = new Set([
  HOLDING_WORKFLOW_NAME,
  TURN_WORKFLOW_NAME,
  SESSION_TIMEOUT_WORKFLOW_NAME,
  TASK_RUN_WORKFLOW_NAME,
  WORKFLOW_TOOL_RUN_WORKFLOW_NAME,
  ACTIVITY_COLLECTOR_WORKFLOW_NAME,
]);
