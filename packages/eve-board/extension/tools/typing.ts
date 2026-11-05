import extension from "../extension.ts";
import { defineBoardTypingTool } from "../lib/tools.ts";

export default defineBoardTypingTool(() => extension.config);
