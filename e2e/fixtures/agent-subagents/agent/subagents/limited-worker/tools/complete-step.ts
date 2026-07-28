import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Completes the limited-worker's deterministic test step. Call this exactly once before replying.",
  inputSchema: z.object({}),
  execute() {
    return { completed: true };
  },
});
