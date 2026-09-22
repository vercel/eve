import { defineTool } from "eve/tools";
import { z } from "zod";
import { subagentHookAudit } from "../../subagent-hook-audit";

export default defineTool({
  description: "Read the parent session's durable subagent hook observations.",
  inputSchema: z.strictObject({}),
  execute: () => subagentHookAudit.get(),
});
