import { z } from "zod";

import { app, desktopTool, flag, windowId } from "../lib/tool";

export default desktopTool({
  description:
    "Send a key or key combo, such as return, escape, ctrl+s, or shift+tab, to an app or the focused window.",
  inputSchema: z.object({
    combo: z.string().describe("Key combo: return, escape, ctrl+c, shift+tab ..."),
    app,
    windowId,
  }),
  argv: (input) => [
    "press",
    ...flag("app", input.app),
    ...flag("window-id", input.windowId),
    "--",
    input.combo,
  ],
});
