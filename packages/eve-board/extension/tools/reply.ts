import extension from "../extension.ts";
import { defineBoardReplyTool } from "../lib/tools.ts";

export default defineBoardReplyTool(() => extension.config);
