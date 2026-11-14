import { disableTool } from "eve/tools";

/**
 * Disables the built-in web_fetch tool, which runs in the app runtime outside the sandbox's network policy.
 *
 * @remarks The agent works from files on the Drive, and removing web access closes a path for sending their contents to an outside URL.
 */
export default disableTool();
