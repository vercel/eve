import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Delay completion so the parent receipt is observably launch-only.",
  inputSchema: z.object({}),
  outputSchema: z.string(),
  async execute() {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return "DELAY-COMPLETE";
  },
});
