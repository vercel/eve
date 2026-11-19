import extension from "../extension.ts";
import { defineBoardCompleteTaskTool } from "../lib/tools.ts";

/** Completes the task the session claimed, with the result. */
export default defineBoardCompleteTaskTool(() => extension.config);
