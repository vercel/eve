import { disableTool } from "eve/tools";

/**
 * Disables the built-in web_search tool, which a warehouse analyst doesn't need.
 *
 * @remarks Removing it keeps instructions planted in query results, thread history, or recalled memory from sending data out through search queries, and keeps answers grounded in the warehouse.
 */
export default disableTool();
