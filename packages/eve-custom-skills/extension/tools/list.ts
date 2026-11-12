import { defineTool } from "eve/tools";
import { z } from "zod";

import { skillScopes } from "../lib/runtime.ts";
import { loadName, scopeField, withSkillScope } from "../lib/tool-support.ts";

export default defineTool({
  label: {
    start: () => "Listing skills",
    complete: () => "Listed skills",
  },
  description:
    "List custom skills in one scope with their live and latest versions, drafts, validation warning counts, and application modes, plus the scopes available here. Never shows another user's personal skills.",
  inputSchema: z.object({ scope: scopeField }),
  async execute(input, ctx) {
    return withSkillScope(ctx, input.scope, "Failed to list skills.", async (skills, scope) => {
      const summaries = await skills.listSummaries(scope);
      const scopes = await skillScopes(ctx);
      return {
        scopes: scopes.map(({ name, label, readOnly }) => ({
          name,
          for: label,
          ...(readOnly && { readOnly }),
        })),
        count: summaries.length,
        skills: summaries.map((skill) => ({ ...skill, loadName: loadName(scope, skill.name) })),
      };
    });
  },
});
