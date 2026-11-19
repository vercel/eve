import { z } from "zod";

import { desktopTool } from "../lib/tool";

/** Lets the agent list connected displays with their bounds and scale factor. */
export default desktopTool({
  description: "List connected displays with bounds and scale factor.",
  inputSchema: z.object({}),
  argv: () => ["list-displays"],
  deferred: true,
});
