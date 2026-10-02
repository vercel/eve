import { defineTool } from "eve/tools";
import { z } from "zod";
import { dynamicSkillContextAudit } from "../../dynamic-skill-context-audit";

export default defineTool({
  description: "Read the dynamic skill resolver's durable context observations.",
  inputSchema: z.strictObject({}),
  execute: () => dynamicSkillContextAudit.get(),
});
