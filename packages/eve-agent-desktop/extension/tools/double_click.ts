import { refAction } from "../lib/tool";

/** Lets the agent physically double-click an element. Requires the extension to run `headed`. */
export default refAction(
  "double-click",
  "Physically double-click an element. Requires the extension to run headed.",
  { deferred: true, headed: true },
);
