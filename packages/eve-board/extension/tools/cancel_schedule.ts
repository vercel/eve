import extension from "../extension.ts";
import { defineBoardCancelScheduleTool } from "../lib/tools.ts";

/** Cancels a scheduled board message. */
export default defineBoardCancelScheduleTool(() => extension.config);
