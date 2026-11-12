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
  action: "publish",
  failure: "Failed to publish the skill version.",
  fallbackCard: ({ name, version }: z.infer<typeof inputSchema>) =>
    `Make skill "${name}" version ${version} live?`,
  async plan(input, { skills, scope }) {
    const name = skills.normalizeName(input.name);
    const planned = await skills.planPublish(scope, name, input.version);
    requireSkillId(name, planned.head.id, input.id);
    const live = planned.head.liveVersion;
    return {
      plan: planned,
      // Making an earlier version live again is a rollback, which the card and approval rule name.
      ...(live !== null && input.version < live && { action: "rollback" as const }),
      changesLive: true,
      targets: [publishTarget(name, planned)],
    };
  },
  async run(plan, { skills, scope, approved }) {
    requireApproval(approved);
    const { skill, previous } = await skills.applyPublish(scope, plan);
    const verb =
      previous.version !== null && skill.version < previous.version ? "Rolled back" : "Published";
    return {
      output: {
        name: skill.name,
        liveVersion: skill.version,
        applicationMode: skill.applicationMode,
        message: `${verb} "${skill.name}" to version ${skill.version}, ${skill.applicationMode}. ${NEXT_TURN}`,
      },
      change: { kind: "published", skill, previous },
    };
  },
});

export default defineTool({
  label: {
    start: ({ name, version }) => `Making ${name} v${version} live`,
    complete: ({ name, version }) => `Made ${name} v${version} live`,
  },
  description:
    "Make an exact saved version of a custom skill the live version, in the application mode it was saved with: a newer draft to publish it, or an earlier version to roll back to it. Read it first. The approval card shows the version's content and is the only confirmation. If the version is already live but not applying, check its application mode instead.",
  inputSchema,
  approval,
  execute,
});
