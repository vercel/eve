/**
 * Error codes carried by delegated agent (`subagent-result`) failures.
 *
 * Codes are diagnostic only: child lifecycle is owned by the owner's task
 * table and is never inferred from an error code. The task kernel mints its
 * own codes (`UNKNOWN_AGENT`, `TIMED_OUT`, ...) in `#tasks/table.js`.
 */

/** Error code for an agent id invoked through the wrong subagent tool. */
export const AGENT_MISMATCH = "AGENT_MISMATCH";

/** Error code for a registered agent that cannot be reached. */
export const AGENT_UNREACHABLE = "AGENT_UNREACHABLE";

/** Error code for an agent that is starting or already running a turn. */
export const AGENT_BUSY = "AGENT_BUSY";

/** Error code for an agent id that names an agent a different caller started. */
export const AGENT_OTHER_PRINCIPAL = "AGENT_OTHER_PRINCIPAL";

/** Error code for a child that could not start: local, remote, or a workflow run. */
export const START_FAILED = "START_FAILED";

/** Error code for delegated work that failed without a code of its own. */
export const EXECUTION_FAILED = "EXECUTION_FAILED";
