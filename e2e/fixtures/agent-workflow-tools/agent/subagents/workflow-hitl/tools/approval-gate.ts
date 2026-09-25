import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Return a deterministic marker after human approval.",
  approval: once(),
  inputSchema: z.strictObject({ marker: z.string() }),
  execute({ marker }) {
    return `WORKFLOW-HITL:${marker}`;
  },
});
