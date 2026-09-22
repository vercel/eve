import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Read the fixture draft's status.",
  inputSchema: z.object({ draftId: z.string() }),
  async execute({ draftId }) {
    return { draftId, status: "ready" };
  },
});
