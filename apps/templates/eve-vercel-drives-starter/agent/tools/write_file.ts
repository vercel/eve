import { disableTool } from "eve/tools";

/**
 * Disables the built-in write_file tool so the model persists files with save_to_drive instead of the session workspace.
 *
 * @remarks This steers the model; it isn't a security control, because `bash` can still write inside the sandbox.
 */
export default disableTool();
