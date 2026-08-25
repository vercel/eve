import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Present an initial change plan for requester confirmation.",
  inputSchema: z.object({ targetUserId: z.string() }),
  approval: always(),
  async execute(input) {
    return { pendingRequesterConfirmation: true, ...input };
  },
});
