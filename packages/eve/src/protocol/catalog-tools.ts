export const SEARCH_TOOL_NAME = "eve__search";
/** Calls a deferred entry or connection tool by name. */
export const CALL_TOOL_NAME = "eve__tool";
/** Loads a skill by name. */
export const SKILL_TOOL_NAME = "eve__skill";

/**
 * The name an `eve__skill` call takes once it resolves inside the harness,
 * where it reports as a `load-skill` action named for its skill. The colon
 * keeps it out of the tool namespace, because skills and tools have separate
 * names. Stream events and client message parts never carry it.
 */
export const SKILL_ENTRY_NAME = "eve:load-skill";
