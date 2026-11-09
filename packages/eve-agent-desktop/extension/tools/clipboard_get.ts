import { z } from "zod";

import { desktopTool } from "../lib/tool";

export default desktopTool({
  description: "Read the desktop clipboard as text.",
  inputSchema: z.object({}),
  argv: () => ["clipboard-get"],
  deferred: true,
});
