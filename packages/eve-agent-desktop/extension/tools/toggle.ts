import { refAction } from "../lib/tool";

/** Lets the agent toggle a checkbox or switch. Not idempotent, unlike the `check` and `uncheck` tools. */
export default refAction(
  "toggle",
  "Toggle a checkbox or switch. Not idempotent: prefer check or uncheck when you know the target state.",
);
