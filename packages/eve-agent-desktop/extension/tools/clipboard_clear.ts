import { z } from "zod";

import { desktopTool } from "../lib/tool";

export default desktopTool({
  description: "Clear the desktop clipboard.",
  inputSchema: z.object({}),
  argv: () => ["clipboard-clear"],
  deferred: true,
});
