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
    start: ({ name, version }) => `Publishing ${name} v${version}`,
    complete: ({ name, version }) => `Published ${name} v${version}`,
  },
  description:
    "Make an exact saved version of a custom skill the live version. Read it first. Approval is bound to the name and version, and the approval card is the only confirmation. If the version is already live but not applying, check its application mode instead.",
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
      "Failed to publish the skill version.",
      async (skills, scope) => {
        const skill = await skills.publish(scope, skillId(input.name), input.version);
        return {
          name: skill.name,
          activeVersion: skill.version,
          applicationMode: skill.applicationMode,
          message: `Published "${skill.name}" version ${skill.version} in ${skill.applicationMode} mode. ${NEXT_TURN}`,
        };
      },
    );
  },
});
