import { disableTool } from "eve/tools";

/**
 * Disables the built-in web_fetch tool, which runs in the app runtime outside the sandbox's network policy.
 *
 * @remarks A memory agent doesn't need web access, and removing it closes a path for sending recalled memory or thread content to an outside URL.
 */
export default disableTool();
