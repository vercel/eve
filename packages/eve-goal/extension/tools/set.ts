import { defineTool } from "eve/tools";
import { z } from "zod";

import extension from "../extension.ts";
import { describe } from "../lib/describe.ts";
import { goal, MAX_OBJECTIVE_LENGTH } from "../lib/state.ts";

export default defineTool({
  description:
    "Set the session's goal: an objective you keep working toward across turns until a judge finds it met. Replaces any current goal. Use it when the person asks you to keep going until something is done.",
  inputSchema: z.object({
    objective: z
      .string()
      .trim()
      .min(1)
      .max(MAX_OBJECTIVE_LENGTH)
      .describe("What done looks like, specific enough to check from tool output."),
  }),
  execute({ objective }) {
    goal.update(() => ({
      idleRuns: 0,
      maxRuns: extension.config.maxRuns,
      objective,
      runs: 0,
      status: "active",
    }));
    return describe(goal.get());
  },
});
