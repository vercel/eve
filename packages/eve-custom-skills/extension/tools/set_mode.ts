import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  NEXT_TURN,
  modeField,
  nameField,
  scopeField,
  skillId,
  versionField,
  withSkillScope,
} from "../lib/tool-support.ts";

export default defineTool({
  label: {
    start: ({ name, mode }) => `Setting ${name} to ${mode}`,
    complete: ({ name, mode }) => `Set ${name} to ${mode}`,
  },
  description:
    "Change how the live version of a custom skill applies. Pass the exact live version. The user's explicit request is the authorization; do not ask again.",
  inputSchema: z.object({
    name: nameField,
    version: versionField,
    mode: modeField,
    scope: scopeField,
  }),
  async execute(input, ctx) {
    return withSkillScope(
      ctx,
      input.scope,
      "Failed to change the application mode.",
      async (skills, scope) => {
        const skill = await skills.setMode(scope, skillId(input.name), input.version, input.mode);
        return {
          name: skill.name,
          activeVersion: skill.version,
          applicationMode: skill.applicationMode,
          message: `"${skill.name}" version ${skill.version} is now ${skill.applicationMode}. ${NEXT_TURN}`,
        };
      },
    );
  },
});
