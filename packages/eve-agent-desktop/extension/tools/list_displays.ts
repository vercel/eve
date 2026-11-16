import { z } from "zod";

import { desktopTool } from "../lib/tool";

export default desktopTool({
  description: "List connected displays with bounds and scale factor.",
  inputSchema: z.object({}),
  argv: () => ["list-displays"],
  deferred: true,
});
