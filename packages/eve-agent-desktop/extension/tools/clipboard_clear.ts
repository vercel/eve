import { z } from "zod";

import { desktopTool } from "../lib/tool";

/** Lets the agent clear the desktop clipboard. */
export default desktopTool({
  description: "Clear the desktop clipboard.",
  inputSchema: z.object({}),
  argv: () => ["clipboard-clear"],
  deferred: true,
});
