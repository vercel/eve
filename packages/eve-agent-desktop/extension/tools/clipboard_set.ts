import { z } from "zod";

import { desktopTool } from "../lib/tool";

/** Lets the agent write text to the desktop clipboard. */
export default desktopTool({
  description: "Write text to the desktop clipboard.",
  inputSchema: z.object({ text: z.string() }),
  argv: (input) => ["clipboard-set", "--", input.text],
  deferred: true,
});
