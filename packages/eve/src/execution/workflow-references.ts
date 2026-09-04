import {
  ACTIVITY_COLLECTOR_WORKFLOW_NAME,
  SESSION_TIMEOUT_WORKFLOW_NAME,
  TASK_RUN_WORKFLOW_NAME,
  WORKFLOW_TOOL_RUN_WORKFLOW_NAME,
  TURN_WORKFLOW_NAME,
  HOLDING_WORKFLOW_NAME,
} from "#execution/stable-workflow-names.js";

/**
 * Stable workflow reference used by `start()` to locate the workflow
 * entrypoint registered by the Workflow DevKit builder.
 */
export const holdingWorkflowReference = {
  workflowId: `workflow//eve//${HOLDING_WORKFLOW_NAME}`,
};

/**
 * Independent turn entrypoint selected on the deployment that accepted
 * the submission. The holder never supervises these runs.
 */
export const turnWorkflowReference = {
  workflowId: `workflow//eve//${TURN_WORKFLOW_NAME}`,
};

/** Stable workflow reference for session deadline timers. */
export const sessionTimeoutWorkflowReference = {
  workflowId: `workflow//eve//${SESSION_TIMEOUT_WORKFLOW_NAME}`,
};

/** Stable workflow reference for durable task runs (`experimental.tasks`). */
export const taskRunWorkflowReference = {
  workflowId: `workflow//eve//${TASK_RUN_WORKFLOW_NAME}`,
};

/** Stable workflow reference for root-session activity collectors. */
export const activityCollectorWorkflowReference = {
  workflowId: `workflow//eve//${ACTIVITY_COLLECTOR_WORKFLOW_NAME}`,
};

/** Stable workflow reference for authored workflow tool runs. */
export const workflowToolRunWorkflowReference = {
  workflowId: `workflow//eve//${WORKFLOW_TOOL_RUN_WORKFLOW_NAME}`,
};
