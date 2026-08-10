import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Release one fanout task after its parent remains interactive.",
  inputSchema: z.object({ marker: z.enum(["RELEASE", "TASK-FAN-IN-1", "TASK-FAN-IN-2"]) }),
  approval: once(),
  execute: async ({ marker }) => ({ marker, released: true }),
});
