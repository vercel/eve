import extension from "../extension.ts";
import { defineBoardCancelScheduleTool } from "../lib/tools.ts";

export default defineBoardCancelScheduleTool(() => extension.config);
