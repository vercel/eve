import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Record Alice's release after approval.",
  inputSchema: z.strictObject({ service: z.string() }),
  approval: ({ toolInput }) => (toolInput?.service === "review-only" ? "denied" : "user-approval"),
  async *execute({ service }) {
    "use workflow";

    yield "approved deployment started";
    return { deployed: service };
  },
});
