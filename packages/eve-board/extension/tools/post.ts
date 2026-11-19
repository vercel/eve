import extension from "../extension.ts";
import { defineBoardPostTool } from "../lib/tools.ts";

/** Starts a board thread in a channel. */
export default defineBoardPostTool(() => extension.config);
