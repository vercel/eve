import { always } from "eve/tools/approval";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { goal } from "../lib/state.ts";

export default defineTool({
  description: "Clear the session's goal. The person approves it.",
  inputSchema: z.object({}),
  approval: always(),
  execute() {
    goal.update(() => null);
    return { goal: null };
  },
});
