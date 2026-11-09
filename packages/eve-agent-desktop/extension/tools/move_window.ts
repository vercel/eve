import { z } from "zod";

import { app, desktopTool, flag, windowId } from "../lib/tool";

export default desktopTool({
  description: "Move an app window to a screen position.",
  inputSchema: z.object({ app, windowId, x: z.number(), y: z.number() }),
  argv: (input) => [
    "move-window",
    ...flag("app", input.app),
    ...flag("window-id", input.windowId),
    ...flag("x", input.x),
    ...flag("y", input.y),
  ],
  deferred: true,
});
