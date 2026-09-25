/**
 * Error codes carried by delegated agent (`subagent-result`) failures.
 *
 * Codes are diagnostic only: child lifecycle is owned by the owner's task
 * table and is never inferred from an error code. The task kernel mints its
 * own codes (`UNKNOWN_TASK`, `TIMED_OUT`, ...) in `#tasks/`.
 */

/** Error code for a child that could not start: local, remote, or a workflow run. */
export const START_FAILED = "START_FAILED";

/** Error code for delegated work that failed without a code of its own. */
export const EXECUTION_FAILED = "EXECUTION_FAILED";
