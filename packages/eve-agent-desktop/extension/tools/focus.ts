import { refAction } from "../lib/tool";

export default refAction(
  "focus",
  "Give an element keyboard focus. Requires the extension to run headed.",
  { deferred: true },
);
