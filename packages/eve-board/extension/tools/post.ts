import extension from "../extension.ts";
import { defineBoardPostTool } from "../lib/tools.ts";

export default defineBoardPostTool(() => extension.config);
