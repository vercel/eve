import { z } from "zod";

import { desktopTool, flag } from "../lib/tool";

export default desktopTool({
  description:
    "Scroll the mouse wheel at screen coordinates. Positive dy scrolls up. Requires the extension to run headed.",
  inputSchema: z.object({
    x: z.number(),
    y: z.number(),
    dy: z.number().optional().describe("Vertical lines; positive up, negative down (default -3)."),
    dx: z.number().optional().describe("Horizontal lines; positive right."),
  }),
  argv: (input) => [
    "mouse-wheel",
    ...flag("x", input.x),
    ...flag("y", input.y),
    ...flag("dy", input.dy),
    ...flag("dx", input.dx),
  ],
  deferred: true,
});
