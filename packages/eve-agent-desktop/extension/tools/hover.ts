import { z } from "zod";

import { desktopTool, point, pointArgs } from "../lib/tool";

export default desktopTool({
  description:
    "Move the pointer over an element or to screen coordinates. Requires the extension to run headed.",
  inputSchema: z.object({ target: point }),
  argv: (input) => ["hover", ...pointArgs(input.target, undefined, "xy")],
  deferred: true,
});
