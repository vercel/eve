import extension from "../extension.ts";
import { defineBoardFailTaskTool } from "../lib/tools.ts";

export default defineBoardFailTaskTool(() => extension.config);
