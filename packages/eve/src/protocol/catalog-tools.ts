export const SEARCH_TOOL_NAME = "eve__search";
export const EXECUTE_TOOL_NAME = "eve__execute";

/**
 * The name an `eve__execute({ skill })` call takes once it resolves inside the
 * harness, where it reports as a `load-skill` action, and the tool name of a
 * skill load's client message part. The colon keeps it out of the tool
 * namespace, because skills and tools have separate names.
 */
export const SKILL_ENTRY_NAME = "eve:load-skill";
