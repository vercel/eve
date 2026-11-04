import { z } from "zod";

import { app, desktopTool, flag, windowId } from "../lib/tool";

export default desktopTool({
  description: "Resize an app window in pixels.",
  inputSchema: z.object({
    app,
    windowId,
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  argv: (input) => [
    "resize-window",
    ...flag("app", input.app),
    ...flag("window-id", input.windowId),
    ...flag("width", input.width),
    ...flag("height", input.height),
  ],
  deferred: true,
});
