import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import {
  NEXT_TURN,
  nameField,
  scopeField,
  skillId,
  versionField,
  withSkillScope,
} from "../lib/tool-support.ts";

export default defineTool({
  label: {
    start: ({ name, version }) => `Rolling back ${name} to v${version}`,
    complete: ({ name, version }) => `Rolled back ${name} to v${version}`,
  },
  description:
    "Roll a custom skill back to an exact earlier version. List versions first and pick the target. The approval card is the only confirmation.",
  inputSchema: z.object({
    name: nameField,
    version: versionField,
    scope: scopeField,
  }),
  approval: always(),
  async execute(input, ctx) {
    return withSkillScope(
      ctx,
      input.scope,
      "Failed to roll back the skill.",
      async (skills, scope) => {
        const skill = await skills.rollback(scope, skillId(input.name), input.version);
        return {
          name: skill.name,
          activeVersion: skill.version,
          message: `Rolled "${skill.name}" back to version ${skill.version}. ${NEXT_TURN}`,
        };
      },
    );
  },
});
