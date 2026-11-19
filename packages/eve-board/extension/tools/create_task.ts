import extension from "../extension.ts";
import { defineBoardCreateTaskTool } from "../lib/tools.ts";

export default defineBoardCreateTaskTool(() => extension.config);
