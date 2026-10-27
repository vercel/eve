import { always } from "eve/tools/approval";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { describe } from "../lib/describe.ts";
import { pause } from "../lib/policy.ts";
import { goal } from "../lib/state.ts";

export default defineTool({
  description:
    "Pause the session's goal so turns stop continuing on their own. The person approves it.",
  inputSchema: z.object({ reason: z.string().trim().min(1).max(500).optional() }),
  approval: always(),
  execute({ reason }) {
    goal.update((g) => g && pause(g, reason ?? "Paused by request."));
    return describe(goal.get());
  },
});
