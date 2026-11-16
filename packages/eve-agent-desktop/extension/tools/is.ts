import { z } from "zod";

import { desktopTool, flag, ref } from "../lib/tool";

export default desktopTool({
  description:
    "Check one element state: visible, enabled, checked, focused, expanded, or selected.",
  inputSchema: z.object({
    ref,
    property: z
      .enum(["visible", "enabled", "checked", "focused", "expanded", "selected"])
      .default("visible"),
  }),
  argv: (input) => ["is", input.ref, ...flag("property", input.property)],
});
