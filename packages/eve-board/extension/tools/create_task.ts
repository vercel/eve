import extension from "../extension.ts";
import { defineBoardCreateTaskTool } from "../lib/tools.ts";

/** Creates a board task, with routing labels and the tasks it waits for. */
export default defineBoardCreateTaskTool(() => extension.config);
