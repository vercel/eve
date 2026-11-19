import extension from "../extension.ts";
import { defineBoardNoteTool } from "../lib/tools.ts";

export default defineBoardNoteTool(() => extension.config);
