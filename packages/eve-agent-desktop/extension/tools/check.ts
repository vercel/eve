import { refAction } from "../lib/tool";

/** Lets the agent set a checkbox or switch to checked, leaving it unchanged when already checked. */
export default refAction("check", "Set a checkbox or switch to checked (idempotent).");
