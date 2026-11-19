import extension from "../extension.ts";
import { defineBoardCompleteTaskTool } from "../lib/tools.ts";

export default defineBoardCompleteTaskTool(() => extension.config);
