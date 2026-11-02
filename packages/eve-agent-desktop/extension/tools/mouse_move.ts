import { z } from "zod";

import { desktopTool, flag } from "../lib/tool";

export default desktopTool({
  description:
    "Move the pointer to absolute screen coordinates. Requires the extension to run headed.",
  inputSchema: z.object({ xy: z.string().describe("Screen coordinates as x,y.") }),
  argv: (input) => ["mouse-move", ...flag("xy", input.xy)],
  deferred: true,
});
