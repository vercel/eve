import { z } from "#compiled/zod/index.js";

import { executeLoadSkillTool } from "#execution/tools/load-skill.js";
import type { ToolDefinition } from "#public/definitions/tool.js";

export const LOAD_SKILL_INPUT_SCHEMA = z.strictObject({
  skill: z.string().describe("Available skill name or id."),
});
export const LOAD_SKILL_OUTPUT_SCHEMA = z.string();

/** Input accepted by the load-skill primitive. */
export type LoadSkillInput = z.infer<typeof LOAD_SKILL_INPUT_SCHEMA>;

/** eve's canonical default skill-loading definition. */
export const loadSkill: ToolDefinition = {
  description: [
    "Load the full instructions for one available skill by name or id.",
    "Use this tool when the request clearly matches a listed skill description or when the user explicitly asks for that skill.",
    "Loading adds the skill instructions to the current turn.",
    'Choose the "skill" value from the Available skills block.',
  ].join(" "),
  execute: async (input) => executeLoadSkillTool(input as LoadSkillInput),
  inputSchema: LOAD_SKILL_INPUT_SCHEMA,
  outputSchema: LOAD_SKILL_OUTPUT_SCHEMA,
};
