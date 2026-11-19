import { z } from "zod";

import { desktopTool, flag } from "../lib/tool";

/** Lets the agent list running GUI applications with the names the other tools accept for `app`. */
export default desktopTool({
  description: "List running GUI applications with the names the other tools accept for app.",
  inputSchema: z.object({ app: z.string().optional().describe("Filter by name substring.") }),
  argv: (input) => ["list-apps", ...flag("app", input.app)],
});
