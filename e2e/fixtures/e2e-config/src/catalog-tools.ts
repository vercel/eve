// The names eve's built-in tools ship under. eve doesn't export them, so the
// fixtures' scripts and evals share these to stay on the shipped names.

/** Searches the agent's own catalog of deferred tools, agents, and skills. */
export const SEARCH_TOOL = "eve__search";

/** Calls a deferred tool, agent, or connection tool by name. */
export const CALL_TOOL = "eve__tool";

/** Loads a skill by name. */
export const SKILL_TOOL = "eve__skill";

/** Waits for running tasks. */
export const TASK_WAIT_TOOL = "eve__task_wait";
