import { disableTool } from "eve/tools";

/**
 * Disables the built-in write_file tool so the model records what it learns with the memory tools instead of files.
 *
 * @remarks This steers the model; it isn't a security control, because `bash` can still write inside the sandbox.
 */
export default disableTool();
