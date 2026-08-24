/**
 * Names of eve's workflow functions whose bundled id is stable across
 * deployments (no `@<pkg.version>` stamp). The bundler reads this set when
 * emitting the workflow id so cross-deployment routing — `start(ref, args, {
 * deploymentId: "latest" })` — finds the same workflow on a newer deployment
 * even when the eve version differs.
 *
 * Dependency-free on purpose: the bundler imports it without pulling in the
 * execution runtime, and the runtime's reference templates read the same
 * names so the two halves of the contract cannot drift.
 */
export const WORKFLOW_ENTRY_NAME = "workflowEntry";
export const TURN_WORKFLOW_NAME = "turnWorkflow";
export const SESSION_TIMEOUT_WORKFLOW_NAME = "sessionTimeoutWorkflow";
export const TASK_RUN_WORKFLOW_NAME = "taskRunWorkflow";
export const TOOL_RUN_WORKFLOW_NAME = "toolRunWorkflow";
export const ACTIVITY_COLLECTOR_WORKFLOW_NAME = "activityCollectorWorkflow";

export const STABLE_WORKFLOW_NAMES: ReadonlySet<string> = new Set([
  WORKFLOW_ENTRY_NAME,
  TURN_WORKFLOW_NAME,
  SESSION_TIMEOUT_WORKFLOW_NAME,
  TASK_RUN_WORKFLOW_NAME,
  TOOL_RUN_WORKFLOW_NAME,
  ACTIVITY_COLLECTOR_WORKFLOW_NAME,
]);
