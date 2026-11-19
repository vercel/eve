import extension from "../extension.ts";
import { defineBoardBlockTaskTool } from "../lib/tools.ts";

/** Holds the task the session claimed for a person, with the one question they must answer. */
export default defineBoardBlockTaskTool(() => extension.config);
