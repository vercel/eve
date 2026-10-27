import { defineTool } from "eve/tools";
import { z } from "zod";

import { describe } from "../lib/describe.ts";
import { goal } from "../lib/state.ts";

export default defineTool({
  description:
    "Report the session's goal: its objective, status, runs, and the judge's last reason.",
  inputSchema: z.object({}),
  execute() {
    return describe(goal.get());
  },
});
