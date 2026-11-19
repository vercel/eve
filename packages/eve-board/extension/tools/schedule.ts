import extension from "../extension.ts";
import { defineBoardScheduleTool } from "../lib/tools.ts";

export default defineBoardScheduleTool(() => extension.config);
