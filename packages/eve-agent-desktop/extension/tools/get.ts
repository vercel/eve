import { z } from "zod";

import { desktopTool, flag, ref } from "../lib/tool";

export default desktopTool({
  description:
    "Read one property of an element: text (what a person reads), value, title, bounds, role, or states.",
  inputSchema: z.object({
    ref,
    property: z.enum(["text", "value", "title", "bounds", "role", "states"]).default("text"),
  }),
  argv: (input) => ["get", input.ref, ...flag("property", input.property)],
});
