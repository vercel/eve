import extension from "../extension.ts";
import { defineBoardReactTool } from "../lib/tools.ts";

/** Adds or removes a reaction on a board message. */
export default defineBoardReactTool(() => extension.config);
