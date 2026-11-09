import { defineTool } from "eve/tools";
import { z } from "zod";

import { nameField, requireApproval, scopeField, skillChange } from "../lib/tool-support.ts";

const inputSchema = z.object({
  names: z.array(nameField).min(1).max(25),
  scope: scopeField,
});

function subject(names: readonly string[]): string {
  return names.length === 1 ? (names[0] ?? "1 skill") : `${names.length} skills`;
}

const { approval, execute } = skillChange({
  action: "remove",
  failure: "Failed to delete the skills.",
  fallbackCard: ({ names }: z.infer<typeof inputSchema>) =>
    `Delete ${subject(names)} with every version?`,
  async plan(input, { skills, scope }) {
    const names = [...new Set(input.names.map((name) => skills.normalizeName(name)))];
    const live = await skills.liveStates(scope, names);
    const found = names.flatMap((name, index) => {
      const state = live[index];
      return state ? [{ name, state }] : [];
    });
    return {
      plan: {
        skills: found.map(({ name, state }) => ({ id: state.id, name })),
        missing: names.filter((_, index) => !live[index]),
      },
      changesLive: found.length > 0,
      targets: found.map(({ name, state }) => ({ id: state.id, name, warnings: [], live: state })),
    };
  },
  async run(plan, { skills, scope, approved }) {
    requireApproval(approved);
    const { removed, notFound } = await skills.remove(scope, plan.skills);
    return {
      output: {
        deleted: removed.map(({ name }) => name),
        notFound: [...plan.missing, ...notFound.map(({ name }) => name)],
      },
      ...(removed.length > 0 && { change: { kind: "removed" as const, skills: removed } }),
    };
  },
});

export default defineTool({
  label: {
    start: ({ names }) => `Deleting ${subject(names)}`,
    complete: ({ names }) => `Deleted ${subject(names)}`,
  },
  description:
    "Permanently delete one or more custom skills in one scope with every version. Pass every name in a single call rather than one call per skill. The approval card names them and is the only confirmation.",
  inputSchema,
  approval,
  execute,
});
