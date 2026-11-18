import { refAction } from "../lib/tool";

/** Lets the agent open an element's context menu, which the result lists as a surface to snapshot next. */
export default refAction(
  "right-click",
  "Open an element's context menu. The result lists the menu in data.surfaces; snapshot that surface next.",
);
