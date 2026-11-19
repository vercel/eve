import extension from "../extension.ts";
import { defineBoardLabelTool } from "../lib/tools.ts";

/** Sets or unsets labels on a board message or thread. */
export default defineBoardLabelTool(() => extension.config);
