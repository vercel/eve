import { defineTool } from "eve/tools";
import { z } from "zod";
import { inputHookAudit } from "../../input-hook-audit";

export default defineTool({
  description: "Read the parent session's recorded input-request hook observations.",
  inputSchema: z.strictObject({}),
  execute() {
    return inputHookAudit.get();
  },
});
