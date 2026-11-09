import { z } from "zod";

import { desktopTool } from "../lib/tool";

export default desktopTool({
  description:
    "Report the desktop adapter's health, platform, and accessibility state. An empty supported_surfaces means the accessibility bus did not answer.",
  inputSchema: z.object({}),
  argv: () => ["status"],
  deferred: true,
});
