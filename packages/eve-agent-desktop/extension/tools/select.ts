import { z } from "zod";

import { desktopTool, flag, ref, timeoutMs } from "../lib/tool";

export default desktopTool({
  description: "Select an option in a list, combo box, or dropdown by its visible text.",
  inputSchema: z.object({ ref, value: z.string().describe("The option to select."), timeoutMs }),
  argv: (input) => ["select", ...flag("timeout-ms", input.timeoutMs), input.ref, "--", input.value],
});
