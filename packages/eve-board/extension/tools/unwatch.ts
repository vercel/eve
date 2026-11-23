import extension from "../extension.ts";
import { defineBoardUnwatchTool } from "../lib/tools.ts";

/** Removes one of the agent's board watches by its ID. */
export default defineBoardUnwatchTool(() => extension.config);
