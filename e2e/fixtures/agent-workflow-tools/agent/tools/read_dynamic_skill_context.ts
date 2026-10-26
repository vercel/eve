import { defineTool } from "eve/tools";
import { z } from "zod";
import { dynamicSkillContextObservations } from "../../dynamic-skill-context-audit";

export default defineTool({
  description: "Read the dynamic skill resolver's context observations.",
  inputSchema: z.strictObject({}),
  execute: (_input, ctx) => dynamicSkillContextObservations(ctx.session.id),
});
