import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  idField,
  nameField,
  NEXT_TURN,
  publishTarget,
  requireApproval,
  requireSkillId,
  scopeField,
  skillChange,
  versionField,
} from "../lib/tool-support.ts";

const inputSchema = z.object({
  name: nameField,
  id: idField,
  version: versionField,
  scope: scopeField,
});

const { approval, execute } = skillChange({
  action: "rollback",
  failure: "Failed to roll back the skill.",
  fallbackCard: ({ name, version }: z.infer<typeof inputSchema>) =>
    `Roll back skill "${name}" to version ${version}?`,
  async plan(input, { skills, scope }) {
    const name = skills.normalizeName(input.name);
    const planned = await skills.planRollback(scope, name, input.version);
    requireSkillId(name, planned.head.id, input.id);
    return { plan: planned, changesLive: true, targets: [publishTarget(name, planned)] };
  },
  async run(plan, { skills, scope, approved }) {
    requireApproval(approved);
    const { skill, previous } = await skills.applyPublish(scope, plan);
    return {
      output: {
        name: skill.name,
        liveVersion: skill.version,
        applicationMode: skill.applicationMode,
        message: `Rolled "${skill.name}" back to version ${skill.version}, ${skill.applicationMode}. ${NEXT_TURN}`,
      },
      change: { kind: "published", skill, previous },
    };
  },
});

export default defineTool({
  label: {
    start: ({ name, version }) => `Rolling back ${name} to v${version}`,
    complete: ({ name, version }) => `Rolled back ${name} to v${version}`,
  },
  description:
    "Roll a custom skill back to an exact earlier version, in the application mode that version was saved with. List versions first and pick the target. The approval card is the only confirmation.",
  inputSchema,
  approval,
  execute,
});
