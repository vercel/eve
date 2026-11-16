import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  idField,
  nameField,
  requireApproval,
  scopeField,
  skillChange,
} from "../lib/tool-support.ts";

const inputSchema = z.object({
  skills: z
    .array(z.object({ name: nameField, id: idField }))
    .min(1)
    .max(25)
    .describe("Each skill to delete, by the name and id `list` returned."),
  scope: scopeField,
});

function subject(skills: readonly { readonly name: string }[]): string {
  return skills.length === 1 ? (skills[0]?.name ?? "1 skill") : `${skills.length} skills`;
}

const { approval, execute } = skillChange({
  action: "remove",
  failure: "Failed to delete the skills.",
  fallbackCard: ({ skills }: z.infer<typeof inputSchema>) =>
    `Delete ${subject(skills)} with every version?`,
  async plan(input, { skills, scope }) {
    const requested = input.skills.map(({ name, id }) => ({
      name: skills.normalizeName(name),
      id,
    }));
    const live = await skills.liveStates(
      scope,
      requested.map(({ name }) => name),
    );
    // A name now held by a different skill isn't the one the caller read, so it isn't removed.
    const found = requested.flatMap((skill, index) => {
      const state = live[index];
      return state?.id === skill.id ? [{ ...skill, state }] : [];
    });
    return {
      plan: {
        skills: found.map(({ id, name }) => ({ id, name })),
        missing: requested.filter(({ id }) => !found.some((skill) => skill.id === id)),
      },
      changesLive: found.length > 0,
      targets: found.map(({ id, name, state }) => ({ id, name, warnings: [], live: state })),
    };
  },
  async run(plan, { skills, scope, approved }) {
    requireApproval(approved);
    const { removed, notFound } = await skills.remove(scope, plan.skills);
    return {
      output: {
        deleted: removed.map(({ name }) => name),
        notFound: [...plan.missing, ...notFound].map(({ name }) => name),
      },
      ...(removed.length > 0 && { change: { kind: "removed" as const, skills: removed } }),
    };
  },
});

export default defineTool({
  // Rarely needed, so it stays out of the tool list until the model searches for it.
  deferred: true,
  label: {
    start: ({ skills }) => `Deleting ${subject(skills)}`,
    complete: ({ skills }) => `Deleted ${subject(skills)}`,
  },
  description:
    "Permanently delete one or more custom skills in one scope with every version. Pass every skill, by the name and id `list` returned, in a single call rather than one call per skill. The approval card names them and is the only confirmation.",
  inputSchema,
  approval,
  execute,
});
