import { z } from "zod";

import { app, desktopTool, flag, surface, windowId } from "../lib/tool";

export default desktopTool({
  description:
    "Find elements by role, name, value, or text without a full snapshot. Returns matches with fresh refs. Use when you know what the element is called.",
  inputSchema: z.object({
    app,
    windowId,
    surface,
    role: z
      .string()
      .optional()
      .describe("Accessibility role: button, textfield, checkbox, menuitem ..."),
    name: z.string().optional().describe("Accessible name or label."),
    value: z.string().optional().describe("Current value."),
    text: z.string().optional().describe("Text in the name, value, title, or description."),
    exact: z.boolean().optional().describe("Require exact (case-insensitive) matches."),
    root: z.string().optional().describe("Search only inside this ref's subtree."),
    first: z.boolean().optional().describe("Return only the first match."),
    limit: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Return at most N matches (default 50)."),
  }),
  argv: (input) => [
    "find",
    ...flag("app", input.app),
    ...flag("window-id", input.windowId),
    ...flag("surface", input.surface),
    ...flag("role", input.role),
    ...flag("name", input.name),
    ...flag("value", input.value),
    ...flag("text", input.text),
    ...flag("exact", input.exact),
    ...flag("root", input.root),
    ...(input.first ? ["--first"] : flag("limit", input.limit)),
  ],
});
