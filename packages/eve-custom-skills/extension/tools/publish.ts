import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  nameField,
  NEXT_TURN,
  publishTarget,
  requireApproval,
  scopeField,
  skillChange,
  versionField,
} from "../lib/tool-support.ts";

const inputSchema = z.object({ name: nameField, version: versionField, scope: scopeField });

const { approval, execute } = skillChange({
  action: "publish",
  failure: "Failed to publish the skill version.",
  fallbackCard: ({ name, version }: z.infer<typeof inputSchema>) =>
    `Publish skill "${name}" version ${version}?`,
  async plan(input, { skills, scope }) {
    const name = skills.normalizeName(input.name);
    const planned = await skills.planPublish(scope, name, input.version);
    return {
      plan: { name, version: input.version },
      changesLive: true,
      targets: [publishTarget(name, planned)],
    };
  },
  async run({ name, version }, { skills, scope, approved }) {
    requireApproval(approved);
    const { skill, previous } = await skills.publish(scope, name, version);
    return {
      output: {
        name: skill.name,
        liveVersion: skill.version,
        applicationMode: skill.applicationMode,
        message: `Published "${skill.name}" version ${skill.version} in ${skill.applicationMode} mode. ${NEXT_TURN}`,
      },
      change: { kind: "published", skill, previous },
    };
  },
});

export default defineTool({
  label: {
    start: ({ name, version }) => `Publishing ${name} v${version}`,
    complete: ({ name, version }) => `Published ${name} v${version}`,
  },
  description:
    "Make an exact saved version of a custom skill the live version, in the application mode it was saved with. Read it first. The approval card shows the version's content and is the only confirmation. If the version is already live but not applying, check its application mode instead.",
  inputSchema,
  approval,
  execute,
});
