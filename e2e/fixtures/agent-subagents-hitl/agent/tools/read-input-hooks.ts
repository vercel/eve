import { defineTool } from "eve/tools";
import { z } from "zod";
import { inputHookAudit } from "../../input-hook-audit";

export default defineTool({
  description: "Read the parent session's durable input request channel and hook observations.",
  inputSchema: z.strictObject({}),
  execute: () => inputHookAudit.get(),
});
