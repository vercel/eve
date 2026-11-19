import extension from "../extension.ts";
import { defineBoardNoteTool } from "../lib/tools.ts";

/** Keeps a reply on the board only, without syncing it to Slack, GitHub, or Linear. */
export default defineBoardNoteTool(() => extension.config);
