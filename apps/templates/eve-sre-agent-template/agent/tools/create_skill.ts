import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { resolveSlackUser } from "#lib/auth.ts";
import {
  getCustomSkillStore,
  getSkillLoadName,
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_MARKDOWN_LENGTH,
  MAX_SKILL_NAME_LENGTH,
  SkillStoreError,
} from "#lib/skills/store.ts";

export const createSkillInputSchema = z.object({
  description: z
    .string()
    .min(1)
    .max(MAX_SKILL_DESCRIPTION_LENGTH)
    .describe("Description used to route this skill."),
  instructions: z
    .string()
    .min(1)
    .max(MAX_SKILL_MARKDOWN_LENGTH)
    .describe("The full Markdown procedure to follow when this skill loads."),
  name: z
    .string()
    .min(1)
    .max(MAX_SKILL_NAME_LENGTH)
    .describe(
      "Short identifier, normalized to lowercase letters, numbers, and hyphens."
    ),
  scope: z
    .enum(["global", "user"])
    .describe(
      "Whether the skill is available to everyone, or just the current user."
    ),
});

export default defineTool({
  approval: always(),
  description:
    "Create or overwrite a custom skill. Use when a user wants you to do something a particular way, or when a user wants to create a runbook that anyone can follow for specific alerts/incidents. Use `list_skills` to determine if similar custom skills already exist in the global scope or the scope for the current user.",
  async execute(input, ctx) {
    const { current } = ctx.session.auth;
    if (!resolveSlackUser(current)) {
      console.error("[sre/custom-skills] create_skill authorization denied", {
        authenticator: current?.authenticator ?? null,
        issuer: current?.issuer ?? null,
        principalId: current?.principalId ?? null,
        principalType: current?.principalType ?? null,
        teamId:
          typeof current?.attributes.team_id === "string"
            ? current.attributes.team_id
            : null,
        userId:
          typeof current?.attributes.user_id === "string"
            ? current.attributes.user_id
            : null,
      });
      return {
        error: "Authorization denied: a human Slack user is required.",
        success: false,
      };
    }
    try {
      const skill = await getCustomSkillStore().save(
        ctx.session.auth.current,
        input.scope,
        {
          description: input.description,
          markdown: input.instructions,
          name: input.name,
        }
      );
      return {
        loadName: getSkillLoadName(skill.name),
        message: `Saved ${skill.scope} skill "${skill.name}". It becomes loadable on the next message.`,
        name: skill.name,
        scope: skill.scope,
        success: true,
      };
    } catch (error) {
      if (error instanceof SkillStoreError) {
        return { error: error.message, success: false };
      }
      console.error("[sre/custom-skills] failed to save skill", error);
      return {
        error:
          "Failed to save the skill. The skill store may not be configured.",
        success: false,
      };
    }
  },
  inputSchema: createSkillInputSchema,
});
