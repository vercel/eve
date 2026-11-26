import extension from "../extension.ts";
import { defineBoardTasksTool } from "../lib/tools.ts";

/** Lists board tasks, oldest first, with their state, holder, and owner. */
export default defineBoardTasksTool(() => extension.config);
