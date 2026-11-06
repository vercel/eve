import { defineTool } from "eve/tools";
import { z } from "zod";

import { nameField, scopeField, skillId, withSkillScope } from "../lib/tool-support.ts";

export default defineTool({
  label: {
    start: ({ name }) => `Listing versions of ${name}`,
    complete: ({ name }) => `Listed versions of ${name}`,
  },
  description:
    "List every version of one custom skill, newest first, with each status (active, draft above the live version, or superseded below it), checksum, and validation result, without the instructions.",
  inputSchema: z.object({ name: nameField, scope: scopeField }),
  async execute(input, ctx) {
    return withSkillScope(
      ctx,
      input.scope,
      "Failed to list skill versions.",
      async (skills, scope) => ({
        versions: (await skills.listVersions(scope, skillId(input.name))).map((skill) => ({
          version: skill.version,
          status: skill.status,
          description: skill.description,
          checksum: skill.checksum,
          validation: skill.validation,
          createdAt: skill.createdAt,
        })),
      }),
    );
  },
});
