import extension from "../extension.ts";
import { defineBoardReleaseTaskTool } from "../lib/tools.ts";

export default defineBoardReleaseTaskTool(() => extension.config);
