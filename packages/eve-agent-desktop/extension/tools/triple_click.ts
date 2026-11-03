import { refAction } from "../lib/tool";

export default refAction(
  "triple-click",
  "Physically triple-click an element. Requires the extension to run headed.",
  { deferred: true, headed: true },
);
