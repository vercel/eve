import { z } from "zod";

import { desktopTool, flag } from "../lib/tool";

export default desktopTool({
  description:
    "Click at absolute screen coordinates. Requires the extension to run headed. Prefer click on a ref.",
  inputSchema: z.object({
    xy: z.string().describe("Screen coordinates as x,y."),
    button: z.enum(["left", "right", "middle"]).default("left"),
    count: z.number().int().positive().max(3).default(1),
  }),
  argv: (input) => [
    "mouse-click",
    ...flag("xy", input.xy),
    ...flag("button", input.button),
    ...flag("count", input.count),
  ],
  deferred: true,
});
