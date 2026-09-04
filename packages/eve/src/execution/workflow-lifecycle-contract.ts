export const WORKFLOW_OWNERSHIP_STREAM_NAMESPACE = "eve:ownership";
export const WORKFLOW_CLEANUP_STREAM_NAMESPACE = "eve:cleanup";

export interface WorkflowOwnership {
  readonly runId: string;
}

export interface WorkflowCleanup {
  readonly released: true;
}
