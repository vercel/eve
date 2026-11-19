import {
  SESSION_TIMEOUT_WORKFLOW_NAME,
  SUBSCRIPTION_DELIVERY_WORKFLOW_NAME,
  SUBSCRIPTION_KEY_WORKFLOW_NAME,
  SUBSCRIPTION_WORKFLOW_NAME,
  WORKFLOW_ENTRY_NAME,
  WORKFLOW_TOOL_RUN_WORKFLOW_NAME,
} from "#execution/stable-workflow-names.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

const STABLE_ID_BASE = EVE_PACKAGE_NAME;

export const workflowEntryReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${WORKFLOW_ENTRY_NAME}`,
};

export const sessionTimeoutWorkflowReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${SESSION_TIMEOUT_WORKFLOW_NAME}`,
};

export const workflowToolRunWorkflowReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${WORKFLOW_TOOL_RUN_WORKFLOW_NAME}`,
};

export const subscriptionWorkflowReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${SUBSCRIPTION_WORKFLOW_NAME}`,
};

export const subscriptionDeliveryWorkflowReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${SUBSCRIPTION_DELIVERY_WORKFLOW_NAME}`,
};

export const subscriptionKeyWorkflowReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${SUBSCRIPTION_KEY_WORKFLOW_NAME}`,
};
