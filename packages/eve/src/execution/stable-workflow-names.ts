const TURN_WORKFLOW_NAME = "turnWorkflow";
export const WORKFLOW_ENTRY_NAME = "workflowEntry";
export const SESSION_TIMEOUT_WORKFLOW_NAME = "sessionTimeoutWorkflow";
export const WORKFLOW_TOOL_RUN_WORKFLOW_NAME = "workflowToolRunWorkflow";
export const SUBSCRIPTION_WORKFLOW_NAME = "subscriptionWorkflow";
export const SUBSCRIPTION_KEY_WORKFLOW_NAME = "subscriptionKeyWorkflow";
export const SUBSCRIPTION_DELIVERY_WORKFLOW_NAME = "subscriptionDeliveryWorkflow";

export const STABLE_WORKFLOW_NAMES: ReadonlySet<string> = new Set([
  WORKFLOW_ENTRY_NAME,
  TURN_WORKFLOW_NAME,
  SESSION_TIMEOUT_WORKFLOW_NAME,
  WORKFLOW_TOOL_RUN_WORKFLOW_NAME,
  SUBSCRIPTION_WORKFLOW_NAME,
  SUBSCRIPTION_KEY_WORKFLOW_NAME,
  SUBSCRIPTION_DELIVERY_WORKFLOW_NAME,
]);
