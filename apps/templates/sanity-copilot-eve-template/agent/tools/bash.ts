import { disableTool } from "eve/tools";

/**
 * Removes the built-in `bash` tool from this agent.
 *
 * @remarks
 * The copilot reads skill references from the sandbox but never needs to run commands in it or
 * change it.
 */
export default disableTool();
