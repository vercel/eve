/**
 * Error codes carried by delegated agent (`subagent-result`) failures.
 *
 * Every producer that mints a code imports from this module, so the set
 * stays closed. Codes are diagnostic only: child lifecycle is owned by the
 * agent handle store and is never inferred from an error code.
 */

/** Error code for a requested agent id that is not registered. */
export const AGENT_UNKNOWN = "AGENT_UNKNOWN";

/** Error code for an agent id invoked through the wrong subagent tool. */
export const AGENT_MISMATCH = "AGENT_MISMATCH";

/** Error code for a registered agent that cannot be reached. */
export const AGENT_UNREACHABLE = "AGENT_UNREACHABLE";

/** Error code for an agent that is starting or already running a turn. */
export const AGENT_BUSY = "AGENT_BUSY";

/** Error code for a local subagent that failed to start. */
export const SUBAGENT_START_FAILED = "SUBAGENT_START_FAILED";

/** Error code for a delegated subagent whose execution threw. */
export const SUBAGENT_EXECUTION_FAILED = "SUBAGENT_EXECUTION_FAILED";

/** Error code for a remote agent session that failed to start. */
export const REMOTE_AGENT_START_FAILED = "REMOTE_AGENT_START_FAILED";

/** Fallback error code for a remote `session.failed` callback without error detail. */
export const REMOTE_AGENT_FAILED = "REMOTE_AGENT_FAILED";

/** Error code a child session reports back when the whole session failed. */
export const SESSION_FAILED = "SESSION_FAILED";
