import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  NEXT_TURN,
  modeField,
  nameField,
  scopeField,
  withSkillScope,
} from "../lib/tool-support.ts";
import { MAX_SKILL_DESCRIPTION_LENGTH, MAX_SKILL_MARKDOWN_LENGTH } from "../lib/validation.ts";

export default defineTool({
  label: {
    start: ({ name }) => `Saving skill ${name}`,
    complete: ({ name }) => `Saved skill ${name}`,
  },
  description:
    "Save a new immutable version of a custom skill. A clean first version goes live immediately; a first version with validation warnings, and every later version of an existing skill, is saved as a draft that the `publish` tool makes live. Always choose the application mode.",
  inputSchema: z.object({
    name: nameField.describe(
      "Short identifier, e.g. 'deploy-checklist'. Normalized to lowercase letters, numbers, and hyphens.",
    ),
    description: z
      .string()
      .min(1)
      .max(MAX_SKILL_DESCRIPTION_LENGTH)
      .describe(
        "One-line routing condition, e.g. 'Use when the user asks for a production deploy checklist.' On-demand and deferred skills must start with 'Use when the user asks', 'requests', 'wants', or 'needs'. No behavior instructions.",
      ),
    instructions: z
      .string()
      .min(1)
      .max(MAX_SKILL_MARKDOWN_LENGTH)
      .describe("The full skill procedure in Markdown."),
    applicationMode: modeField,
    scope: scopeField,
  }),
  async execute(input, ctx) {
    return withSkillScope(ctx, input.scope, "Failed to save the skill.", async (skills, scope) => {
      const skill = await skills.save(
        scope,
        {
          name: input.name,
          description: input.description,
          markdown: input.instructions,
          applicationMode: input.applicationMode,
        },
        { idempotencyKey: ctx.callId },
      );
      const live = skill.status === "active";
      const stays =
        skill.activeVersion === null
          ? "No version is live yet."
          : `Version ${skill.activeVersion} stays live.`;
      return {
        name: skill.name,
        version: skill.version,
        status: skill.status,
        activeVersion: skill.activeVersion,
        applicationMode: skill.applicationMode,
        loadName: `${scope.loadNamePrefix}${skill.name}`,
        warnings: skill.validation.warnings,
        message: live
          ? `Saved and activated "${skill.name}" version ${skill.version} in ${skill.applicationMode} mode. ${NEXT_TURN}`
          : `Saved "${skill.name}" version ${skill.version} as a draft. ${stays} Publish this exact version if the user asked for it to go live; the approval card is the only confirmation.`,
      };
    });
  },
});
