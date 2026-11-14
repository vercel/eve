import { disableTool } from "eve/tools";

/**
 * Disables the built-in web_search tool, which a memory agent doesn't need.
 *
 * @remarks Removing it keeps instructions planted in thread history or recalled memory from sending data out through search queries.
 */
export default disableTool();
