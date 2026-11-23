import extension from "../extension.ts";
import { defineBoardScheduleTool } from "../lib/tools.ts";

/** Schedules a board message that wakes the agent when it posts. */
export default defineBoardScheduleTool(() => extension.config);
