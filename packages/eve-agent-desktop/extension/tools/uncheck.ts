import { refAction } from "../lib/tool";

/** Lets the agent set a checkbox or switch to unchecked, leaving it unchanged when already unchecked. */
export default refAction("uncheck", "Set a checkbox or switch to unchecked (idempotent).");
