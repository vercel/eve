import { z } from "zod";

import { app, desktopTool, flag, surface, windowId } from "../lib/tool";

export default desktopTool({
  description:
    "Read an app window's accessibility tree as JSON. Actionable elements carry qualified refs (@<snapshot>:eN) for the other tools. Interactive-only and compact by default.",
  inputSchema: z.object({
    app,
    windowId,
    surface,
    root: z
      .string()
      .optional()
      .describe(
        "Drill into this ref's subtree from an earlier snapshot instead of the whole window.",
      ),
    skeleton: z
      .boolean()
      .optional()
      .describe(
        "Shallow map of a dense app, with children_count on cut branches. Never use on a menu or dialog surface.",
      ),
    interactiveOnly: z.boolean().default(true).describe("Only include elements you can act on."),
    compact: z.boolean().default(true).describe("Collapse single-child unnamed wrappers."),
    maxDepth: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe("Maximum tree depth (default 10)."),
    includeBounds: z.boolean().optional().describe("Include element bounds."),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Observation deadline (default 3000)."),
  }),
  argv: (input) => [
    "snapshot",
    ...flag("app", input.app),
    ...flag("window-id", input.windowId),
    ...flag("surface", input.surface),
    ...flag("root", input.root),
    ...flag("skeleton", input.skeleton),
    ...flag("interactive-only", input.interactiveOnly),
    ...flag("compact", input.compact),
    ...flag("max-depth", input.maxDepth),
    ...flag("include-bounds", input.includeBounds),
    ...flag("timeout-ms", input.timeoutMs),
  ],
});
