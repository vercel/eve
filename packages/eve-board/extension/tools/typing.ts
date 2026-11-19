import extension from "../extension.ts";
import { defineBoardTypingTool } from "../lib/tools.ts";

/** Shows a short status in a board thread's synced platform threads. */
export default defineBoardTypingTool(() => extension.config);
