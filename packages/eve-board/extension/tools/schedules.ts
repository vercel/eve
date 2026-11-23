import extension from "../extension.ts";
import { defineBoardSchedulesTool } from "../lib/tools.ts";

/** Lists pending scheduled board messages. */
export default defineBoardSchedulesTool(() => extension.config);
