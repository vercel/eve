import { z } from "zod";

import { desktopTool, flag } from "../lib/tool";

export default desktopTool({
  description: "Quit an application gracefully, or terminate it with force.",
  inputSchema: z.object({
    app: z.string().describe("Application name as list_apps prints it."),
    force: z
      .boolean()
      .optional()
      .describe("Terminate instead of quitting gracefully. Unsaved work is lost."),
  }),
  argv: (input) => ["close-app", input.app, ...flag("force", input.force)],
});
