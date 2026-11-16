import { z } from "zod";

import { desktopTool, flag } from "../lib/tool";

export default desktopTool({
  description: "List an app's accessibility surfaces: windows, open menus, sheets, and alerts.",
  inputSchema: z.object({ app: z.string().optional() }),
  argv: (input) => ["list-surfaces", ...flag("app", input.app)],
  deferred: true,
});
