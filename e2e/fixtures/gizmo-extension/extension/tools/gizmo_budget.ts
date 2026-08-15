import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

// Same bare "budget" name as toolkit-extension; eve scopes each per package so
// the counters stay independent.
const budget = defineState("budget", () => ({ count: 0 }));

export default defineTool({
  description:
    "Increment and read the gizmo budget counter. Call when asked to bump the gizmo budget.",
  inputSchema: z.object({}),
  async execute() {
    budget.update((state) => ({ count: state.count + 1 }));
    return { scope: "gizmo", count: budget.get().count };
  },
});
