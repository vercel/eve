import extension from "../extension.ts";
import { defineBoardBlockTaskTool } from "../lib/tools.ts";

export default defineBoardBlockTaskTool(() => extension.config);
