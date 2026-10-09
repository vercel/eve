import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "List the currently open tasks with their IDs and titles.",
  inputSchema: z.object({}),
  execute: () => ({ tasks: [] }),
});
