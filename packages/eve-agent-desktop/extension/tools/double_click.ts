import { refAction } from "../lib/tool";

export default refAction(
  "double-click",
  "Physically double-click an element. Requires the extension to run headed.",
  { deferred: true, headed: true },
);
