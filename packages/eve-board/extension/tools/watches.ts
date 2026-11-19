import extension from "../extension.ts";
import { defineBoardWatchesTool } from "../lib/tools.ts";

/** Lists the agent's board watches. */
export default defineBoardWatchesTool(() => extension.config);
