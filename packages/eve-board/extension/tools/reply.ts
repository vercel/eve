import extension from "../extension.ts";
import { defineBoardReplyTool } from "../lib/tools.ts";

/** Replies in a board thread. */
export default defineBoardReplyTool(() => extension.config);
