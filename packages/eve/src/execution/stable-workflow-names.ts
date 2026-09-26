/**
 * eve workflow functions whose bundled id carries no `@<version>` stamp, so
 * an explicitly stamped deployment can find them across eve versions.
 * Dependency-free so the bundler can import it.
 */
const TURN_WORKFLOW_NAME = "turnWorkflow";
export const WORKFLOW_ENTRY_NAME = "workflowEntry";
export const SESSION_TIMEOUT_WORKFLOW_NAME = "sessionTimeoutWorkflow";
export const WORKFLOW_TOOL_RUN_WORKFLOW_NAME = "workflowToolRunWorkflow";
export const ACTIVITY_COLLECTOR_WORKFLOW_NAME = "activityCollectorWorkflow";
export const TASK_HARD_STOP_WORKFLOW_NAME = "taskHardStopWorkflow";

export const STABLE_WORKFLOW_NAMES: ReadonlySet<string> = new Set([
  WORKFLOW_ENTRY_NAME,
  TURN_WORKFLOW_NAME,
  SESSION_TIMEOUT_WORKFLOW_NAME,
  WORKFLOW_TOOL_RUN_WORKFLOW_NAME,
  ACTIVITY_COLLECTOR_WORKFLOW_NAME,
  TASK_HARD_STOP_WORKFLOW_NAME,
]);
