import { always } from "eve/tools/approval";
import { defineTool } from "eve/tools";
import { z } from "zod";

import extension from "../extension.ts";
import { describe } from "../lib/describe.ts";
import { goal } from "../lib/state.ts";

export default defineTool({
  description:
    "Resume a paused goal with a fresh run and spend budget, so turns continue on their own again. The person approves it.",
  inputSchema: z.object({}),
  approval: always(),
  execute() {
    // A fresh budget: runs and spend count again from here.
    goal.update(
      (g) =>
        g && {
          idleRuns: 0,
          maxRuns: g.runs + extension.config.maxRuns,
          objective: g.objective,
          runs: g.runs,
          status: "active",
        },
    );
    return describe(goal.get());
  },
});
