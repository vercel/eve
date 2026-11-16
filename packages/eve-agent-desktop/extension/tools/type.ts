import { z } from "zod";

import { desktopTool, flag, ref, timeoutMs } from "../lib/tool";

export default desktopTool({
  description: "Insert text into a text field or editor.",
  inputSchema: z.object({ ref, text: z.string(), timeoutMs }),
  argv: (input) => ["type", ...flag("timeout-ms", input.timeoutMs), input.ref, "--", input.text],
});
