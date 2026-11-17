import { refAction } from "../lib/tool";

/** Lets the agent give an element keyboard focus. Requires the extension to run `headed`. */
export default refAction(
  "focus",
  "Give an element keyboard focus. Requires the extension to run headed.",
  { deferred: true, headed: true },
);
