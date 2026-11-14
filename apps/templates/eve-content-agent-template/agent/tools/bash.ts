import { disableTool } from "eve/tools";

/**
 * Removes the built-in `bash` tool from this agent.
 *
 * @remarks
 * The content assistant reads skill references from the sandbox but never needs to change it.
 */
export default disableTool();
