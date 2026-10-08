// The names eve's built-in tools ship under. eve doesn't export them, so the
// fixtures' scripts and evals share these to stay on the shipped names.

/** Searches the agent's own catalog of deferred tools, agents, and skills. */
export const SEARCH_TOOL = "eve__search";

/** Calls a catalog entry by name, or loads a skill. */
export const EXECUTE_TOOL = "eve__execute";

/** Waits for running tasks. */
export const TASK_WAIT_TOOL = "eve__task_wait";
