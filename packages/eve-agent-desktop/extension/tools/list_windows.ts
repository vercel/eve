import { z } from "zod";

import { desktopTool, flag } from "../lib/tool";

export default desktopTool({
  description: "List visible windows with their ids, titles, apps, bounds, and focus state.",
  inputSchema: z.object({ app: z.string().optional().describe("Filter by exact app name.") }),
  argv: (input) => ["list-windows", ...flag("app", input.app)],
});
