import { defineTool } from "eve/tools";
import { z } from "zod";

import type { SavePlan } from "../lib/lifecycle.ts";
import { skillAuthor } from "../lib/scopes.ts";
import {
  loadName,
  modeField,
  nameField,
  NEXT_TURN,
  scopeField,
  skillChange,
} from "../lib/tool-support.ts";
import { INPUT_CEILINGS } from "../lib/validation.ts";

const inputSchema = z.object({
  name: nameField.describe(
    "Short identifier, e.g. 'deploy-checklist'. Normalized to lowercase letters, numbers, and hyphens.",
  ),
  description: z
    .string()
    .min(1)
    .max(INPUT_CEILINGS.description)
    .describe(
      "One-line routing condition, e.g. 'Use when the user asks for a production deploy checklist.' On-demand and deferred skills must start with 'Use when the user asks', 'requests', 'wants', or 'needs'. No behavior instructions.",
    ),
  instructions: z
    .string()
    .min(1)
    .max(INPUT_CEILINGS.instructions)
    .describe("The full skill procedure in Markdown."),
  applicationMode: modeField,
  scope: scopeField,
});

const { approval, execute } = skillChange<z.infer<typeof inputSchema>, SavePlan, object>({
  action: "create",
  failure: "Failed to save the skill.",
  fallbackCard: ({ name, scope }) =>
    `Save skill "${name}"${scope ? ` in the ${scope} scope` : ""}?`,
  async plan(input, { skills, scope }) {
    const plan = await skills.planSave(scope, {
      name: input.name,
      description: input.description,
      markdown: input.instructions,
      applicationMode: input.applicationMode,
    });
    return {
      plan,
      changesLive: plan.activates,
      targets: [
        {
          ...(plan.id !== null && { id: plan.id }),
          name: plan.name,
          version: plan.version,
          description: plan.description,
          instructions: plan.markdown,
          applicationMode: plan.applicationMode,
          warnings: plan.validation.warnings,
          live: plan.live,
        },
      ],
    };
  },
  async run(plan, { skills, scope, approved, ctx }) {
    const { skill, previous, replayed } = await skills.save(scope, plan, {
      savedBy: skillAuthor(ctx.session.auth.current),
      idempotencyKey: `${ctx.session.id}:${ctx.callId}`,
      // A first version that now needs approval nobody gave waits as a draft.
      draft: !approved,
    });
    const live = skill.status === "active";
    const stays =
      skill.liveVersion === null
        ? "No version is live yet."
        : `Version ${skill.liveVersion} stays live.`;
    return {
      output: {
        id: skill.id,
        name: skill.name,
        version: skill.version,
        status: skill.status,
        liveVersion: skill.liveVersion,
        applicationMode: skill.applicationMode,
        loadName: loadName(scope, skill.name),
        warnings: skill.validation.warnings,
        message: live
          ? `Saved and activated "${skill.name}" version ${skill.version} in ${skill.applicationMode} mode. ${NEXT_TURN}`
          : `Saved "${skill.name}" version ${skill.version} as a draft. ${stays} Publish this exact version if the user asked for it to go live; the approval card is the only confirmation.`,
      },
      ...(!replayed && { change: { kind: "saved" as const, skill, previous } }),
    };
  },
});

export default defineTool({
  label: {
    start: ({ name }) => `Saving skill ${name}`,
    complete: ({ name }) => `Saved skill ${name}`,
  },
  description:
    "Save a new immutable version of a custom skill. A clean first version goes live immediately; a first version with validation warnings, and every later version of an existing skill, is saved as a draft that the `publish` tool makes live. A draft never changes the live version or its mode. Always choose the application mode.",
  inputSchema,
  approval,
  execute,
});
