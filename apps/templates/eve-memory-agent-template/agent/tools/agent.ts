import { disableTool } from "eve/tools";

/**
 * Disables the built-in agent tool, so the model can't delegate work to child agents that share its tools and sandbox.
 */
export default disableTool();
