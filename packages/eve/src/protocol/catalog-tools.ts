export const SEARCH_TOOL_NAME = "search";
export const EXECUTE_TOOL_NAME = "execute";

/** The catalog tools' names. Every session has both, so no other entry can use them. */
export const CATALOG_TOOL_NAMES: readonly string[] = [SEARCH_TOOL_NAME, EXECUTE_TOOL_NAME];
