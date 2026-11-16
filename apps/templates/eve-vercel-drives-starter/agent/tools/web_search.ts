import { disableTool } from "eve/tools";

/**
 * Disables the built-in web_search tool, which an agent that answers from Drive files doesn't need.
 *
 * @remarks Removing it keeps instructions planted in Drive files or thread history from sending data out through search queries.
 */
export default disableTool();
