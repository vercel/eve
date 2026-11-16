import { z } from "zod";

import { app, desktopTool, flag, windowId } from "../lib/tool";

export default desktopTool({
  description: "Bring a window to the front and confirm it has focus.",
  inputSchema: z.object({
    windowId,
    app,
    title: z.string().optional().describe("Window title (partial match)."),
  }),
  argv: (input) => [
    "focus-window",
    ...flag("window-id", input.windowId),
    ...flag("app", input.app),
    ...flag("title", input.title),
  ],
});
