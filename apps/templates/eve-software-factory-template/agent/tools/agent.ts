import { disableTool } from "eve/tools";

/**
 * Disables the built-in `agent` tool on the root orchestrator.
 *
 * @remarks
 * The built-in tool runs a fresh copy of the root agent, which would let the
 * orchestrator delegate work to an undifferentiated clone of itself and
 * bypass the four stations. All delegation goes through the declared
 * subagents instead.
 */
export default disableTool();
