import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Complete a task by its ID. Returns whether completion succeeded.",
  inputSchema: z.object({ task_id: z.string() }),
  execute: () => ({ success: false }),
});
