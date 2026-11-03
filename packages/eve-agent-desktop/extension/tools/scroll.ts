import { z } from "zod";

import { desktopTool, flag, ref, timeoutMs } from "../lib/tool";

export default desktopTool({
  description:
    "Scroll a scrollable element. On Linux this sends wheel input and needs the extension to run headed; prefer scroll_to.",
  inputSchema: z.object({
    ref,
    direction: z.enum(["up", "down", "left", "right"]).default("down"),
    amount: z.number().int().positive().default(3).describe("Scroll units."),
    timeoutMs,
  }),
  argv: (input) => [
    "scroll",
    input.ref,
    ...flag("direction", input.direction),
    ...flag("amount", input.amount),
    ...flag("timeout-ms", input.timeoutMs),
  ],
  deferred: true,
  headed: true,
});
