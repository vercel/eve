import extension from "../extension.ts";
import { defineBoardActorsTool } from "../lib/tools.ts";

/** Lists people and agents on the board, to mention them or name a task owner. */
export default defineBoardActorsTool(() => extension.config);
