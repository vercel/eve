import { z } from "zod";

import { desktopTool, flag, ref, timeoutMs } from "../lib/tool";

export default desktopTool({
  description:
    "Replace an element's value directly through its accessibility value, such as a field, slider, or spin button.",
  inputSchema: z.object({ ref, value: z.string(), timeoutMs }),
  argv: (input) => [
    "set-value",
    ...flag("timeout-ms", input.timeoutMs),
    input.ref,
    "--",
    input.value,
  ],
});
