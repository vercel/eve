import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  idField,
  modeField,
  nameField,
  NEXT_TURN,
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
  mode: modeField,
  scope: scopeField,
});

const { approval, execute } = skillChange({
  action: "set_mode",
  failure: "Failed to change the application mode.",
  fallbackCard: ({ name, version, mode }: z.infer<typeof inputSchema>) =>
    `Set skill "${name}" version ${version} to ${mode}?`,
  async plan(input, { skills, scope }) {
    const name = skills.normalizeName(input.name);
    const planned = await skills.planSetMode(scope, name, input.version, input.mode);
    const { head, version } = planned;
    requireSkillId(name, head.id, input.id);
    return {
      plan: { planned, mode: input.mode },
      changesLive: head.applicationMode !== input.mode,
      targets: [
        {
          id: head.id,
          name,
          version: version.version,
          instructions: version.markdown,
          applicationMode: input.mode,
          warnings: version.validation.warnings,
          live: { version: head.liveVersion, applicationMode: head.applicationMode },
        },
      ],
    };
  },
  async run({ planned, mode }, { skills, scope, approved }) {
    requireApproval(approved);
    const { skill, previous } = await skills.applySetMode(scope, planned, mode);
    return {
      output: {
        name: skill.name,
        liveVersion: skill.version,
        applicationMode: skill.applicationMode,
        message: `"${skill.name}" version ${skill.version} is now ${skill.applicationMode}. ${NEXT_TURN}`,
      },
      ...(previous.applicationMode !== skill.applicationMode && {
        change: { kind: "mode" as const, skill, previous },
      }),
    };
  },
});

export default defineTool({
  label: {
    start: ({ name, mode }) => `Setting ${name} to ${mode}`,
    complete: ({ name, mode }) => `Set ${name} to ${mode}`,
  },
  description:
    "Change how the live version of a custom skill applies. Pass the exact live version. In a shared scope the change may need approval; the approval card is the only confirmation.",
  inputSchema,
  approval,
  execute,
});
