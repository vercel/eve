import { z } from "zod";

import { desktopTool, flag } from "../lib/tool";

const TARGET_FLAG = { window: "window", text: "text", element: "element" } as const;

export default desktopTool({
  description:
    "Wait for a window, text, or element to appear, for a menu to open or close, or for a fixed time. Prefer a condition over a fixed time.",
  inputSchema: z.object({
    condition: z.enum(["window", "text", "element", "menu", "menu_closed", "time"]),
    target: z
      .string()
      .optional()
      .describe(
        "Required for window (a title or part of one), text (the text), and element (a ref).",
      ),
    ms: z
      .number()
      .int()
      .positive()
      .max(60_000)
      .optional()
      .describe("Required for time: milliseconds to pause."),
    predicate: z
      .enum(["exists", "enabled", "visible", "actionable", "value"])
      .optional()
      .describe("For element: what to wait for (default exists)."),
    value: z.string().optional().describe("For element with predicate value: the expected value."),
    app: z.string().optional().describe("Scope the wait to this app."),
    timeout: z
      .number()
      .int()
      .positive()
      .max(120_000)
      .optional()
      .describe("Timeout for condition waits (default 30000)."),
  }),
  argv: (input) => {
    let mode: string[];
    if (input.condition === "time") {
      if (input.ms === undefined) throw new Error("wait with condition time needs ms.");
      mode = [String(input.ms)];
    } else if (input.condition === "menu" || input.condition === "menu_closed") {
      mode = [input.condition === "menu" ? "--menu" : "--menu-closed"];
    } else {
      if (input.target === undefined)
        throw new Error(`wait with condition ${input.condition} needs target.`);
      mode = flag(TARGET_FLAG[input.condition], input.target);
    }
    return [
      "wait",
      ...mode,
      ...flag("predicate", input.predicate),
      ...flag("value", input.value),
      ...flag("app", input.app),
      ...flag("timeout", input.timeout),
    ];
  },
});
