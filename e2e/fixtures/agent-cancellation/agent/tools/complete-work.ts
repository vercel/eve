import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Completes a short work item. Call when asked to complete work before answering.",
  inputSchema: z.object({}),
  approval: never(),
  async execute() {
    await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
    return "The work item is complete.";
  },
});
