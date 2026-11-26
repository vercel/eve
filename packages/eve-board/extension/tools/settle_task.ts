import extension from "../extension.ts";
import { defineBoardSettleTaskTool } from "../lib/tools.ts";

/** Claims a ready task by its ID and marks it completed or failed in one step, after the caller approves. */
export default defineBoardSettleTaskTool(() => extension.config);
