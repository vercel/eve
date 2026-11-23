import extension from "../extension.ts";
import { defineBoardReadTool } from "../lib/tools.ts";

/** Reads a board thread, or lists a channel's threads. */
export default defineBoardReadTool(() => extension.config);
