import extension from "../extension.ts";
import { defineBoardReadTool } from "../lib/tools.ts";

export default defineBoardReadTool(() => extension.config);
