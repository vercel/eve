import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { nameField, scopeField, skillId, withSkillScope } from "../lib/tool-support.ts";

function subject(names: readonly string[]): string {
  return names.length === 1 ? (names[0] ?? "1 skill") : `${names.length} skills`;
}

export default defineTool({
  label: {
    start: ({ names }) => `Deleting ${subject(names)}`,
    complete: ({ names }) => `Deleted ${subject(names)}`,
  },
  description:
    "Permanently delete one or more custom skills in one scope with every version. Pass every name in a single call rather than one call per skill. The approval card names them and is the only confirmation.",
  inputSchema: z.object({
    names: z.array(nameField).min(1).max(25),
    scope: scopeField,
  }),
  approval: always(),
  async execute(input, ctx) {
    return withSkillScope(ctx, input.scope, "Failed to delete the skills.", async (skills, scope) =>
      skills.remove(scope, input.names.map(skillId)),
    );
  },
});
