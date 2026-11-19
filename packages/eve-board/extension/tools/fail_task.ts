import extension from "../extension.ts";
import { defineBoardFailTaskTool } from "../lib/tools.ts";

/** Gives up on the task the session claimed, with why. */
export default defineBoardFailTaskTool(() => extension.config);
