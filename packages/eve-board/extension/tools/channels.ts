import extension from "../extension.ts";
import { defineBoardChannelsTool } from "../lib/tools.ts";

export default defineBoardChannelsTool(() => extension.config);
