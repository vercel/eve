import { disableTool } from "eve/tools";

/**
 * Disables the built-in write_file tool, so the model makes changes through the Contentful tools rather than sandbox files.
 *
 * @remarks This steers the model and isn't a security control, because `bash` can still write inside the sandbox.
 */
export default disableTool();
