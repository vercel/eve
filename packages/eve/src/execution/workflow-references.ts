import {
  CONNECTION_EVENT_DELIVERY_WORKFLOW_NAME,
  CONNECTION_EVENT_WORKFLOW_NAME,
  SESSION_TIMEOUT_WORKFLOW_NAME,
  WORKFLOW_ENTRY_NAME,
  WORKFLOW_TOOL_RUN_WORKFLOW_NAME,
} from "#execution/stable-workflow-names.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

// The ids eve's own workflows are registered under, which every deployment of this package shares.

const STABLE_ID_BASE = EVE_PACKAGE_NAME;

/**
 * Stable workflow reference used by `start()` to locate the workflow
 * entrypoint registered by the Workflow DevKit builder. The id omits
 * the package version stamp so the long-lived owner can rotate across
 * deployments without rewriting the registry key.
 */
export const workflowEntryReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${WORKFLOW_ENTRY_NAME}`,
};

/** Stable workflow reference for session deadline timers. */
export const sessionTimeoutWorkflowReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${SESSION_TIMEOUT_WORKFLOW_NAME}`,
};

/** Stable workflow reference for authored workflow tool runs. */
export const workflowToolRunWorkflowReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${WORKFLOW_TOOL_RUN_WORKFLOW_NAME}`,
};

export const connectionEventWorkflowReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${CONNECTION_EVENT_WORKFLOW_NAME}`,
};

export const connectionEventDeliveryWorkflowReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${CONNECTION_EVENT_DELIVERY_WORKFLOW_NAME}`,
};
