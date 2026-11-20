import extension from "../extension.ts";
import { defineBoardChannelsTool } from "../lib/tools.ts";

/** Lists the board channels the agent can read. */
export default defineBoardChannelsTool(() => extension.config);
