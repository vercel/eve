import { refAction } from "../lib/tool";

/** Lets the agent physically triple-click an element. Requires the extension to run `headed`. */
export default refAction(
  "triple-click",
  "Physically triple-click an element. Requires the extension to run headed.",
  { deferred: true, headed: true },
);
