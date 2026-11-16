import { refAction } from "../lib/tool";

export default refAction(
  "toggle",
  "Toggle a checkbox or switch. Not idempotent: prefer check or uncheck when you know the target state.",
);
