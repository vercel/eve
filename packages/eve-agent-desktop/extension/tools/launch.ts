import { z } from "zod";

import { desktopTool, flag, repeated } from "../lib/tool";

export default desktopTool({
  description:
    "Launch an application on the desktop and wait for its window. Attaches to an already running instance.",
  inputSchema: z.object({
    app: z
      .string()
      .describe("Executable or desktop-entry name, such as gnome-calculator or mousepad."),
    args: z.array(z.string()).optional().describe("Command-line arguments for the app, in order."),
    activate: z.boolean().default(true).describe("Wait for the app to present a window."),
    timeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Upper bound for the launch in ms (default 30000)."),
  }),
  argv: (input) => [
    "launch",
    input.app,
    ...repeated("arg", input.args),
    ...flag("activate", input.activate),
    ...flag("timeout", input.timeout),
  ],
});
