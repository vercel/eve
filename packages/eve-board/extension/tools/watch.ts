import extension from "../extension.ts";
import { defineBoardWatchTool } from "../lib/tools.ts";

/** Creates a board watch: matching events wake the agent with the watch's instructions. */
export default defineBoardWatchTool(() => extension.config);
