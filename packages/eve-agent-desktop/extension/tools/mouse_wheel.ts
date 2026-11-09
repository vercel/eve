import { z } from "zod";

import { desktopTool, flag, xy } from "../lib/tool";

export default desktopTool({
  description:
    "Scroll the mouse wheel at screen coordinates. Positive dy scrolls up. Requires the extension to run headed.",
  inputSchema: z.object({
    xy,
    dy: z.number().optional().describe("Vertical lines; positive up, negative down (default -3)."),
    dx: z.number().optional().describe("Horizontal lines; positive right."),
  }),
  argv: (input) => {
    const [x, y] = input.xy.split(",");
    return [
      "mouse-wheel",
      ...flag("x", x),
      ...flag("y", y),
      ...flag("dy", input.dy),
      ...flag("dx", input.dx),
    ];
  },
  deferred: true,
  headed: true,
});
