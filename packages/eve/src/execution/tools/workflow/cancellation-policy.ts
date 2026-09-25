export const WORKFLOW_CANCELLATION_CLEANUP_MS = 30_000;
// Give the owner time to persist its outcome and wake its parent after body cleanup.
export const WORKFLOW_CANCELLATION_SETTLE_MS = WORKFLOW_CANCELLATION_CLEANUP_MS + 5_000;
