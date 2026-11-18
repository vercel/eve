import { z } from "zod";

import { desktopTool, point, pointArgs } from "../lib/tool";

/** Lets the agent drag from one element or point to another. Requires the extension to run `headed`. */
export default desktopTool({
  description: "Drag from one element or point to another. Requires the extension to run headed.",
  inputSchema: z.object({ from: point, to: point }),
  argv: (input) => [
    "drag",
    ...pointArgs(input.from, "from", "from-xy"),
    ...pointArgs(input.to, "to", "to-xy"),
  ],
  deferred: true,
  headed: true,
});
