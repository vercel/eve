import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { resolveSlackUser } from "#lib/auth.ts";
import {
  getCustomSkillStore,
  MAX_SKILL_NAME_LENGTH,
  SkillStoreError,
} from "#lib/skills/store.ts";

export const deleteSkillInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(MAX_SKILL_NAME_LENGTH)
    .describe("The name of the skill to delete."),
  scope: z
    .enum(["global", "user"])
    .describe("The scope of the skill to delete."),
});

export default defineTool({
  approval: always(),
  description:
    "Delete a custom skill/runbook. Use `list_skills`  to find the names/scopes of skills available to delete.",
  async execute(input, ctx) {
    if (!resolveSlackUser(ctx.session.auth.current)) {
      return {
        error: "Authorization denied: a human Slack user is required.",
        success: false,
      };
    }
    try {
      await getCustomSkillStore().delete(
        ctx.session.auth.current,
        input.scope,
        input.name
      );
      return {
        message: `Deleted ${input.scope} skill "${input.name}".`,
        success: true,
      };
    } catch (error) {
      if (error instanceof SkillStoreError) {
        return { error: error.message, success: false };
      }
      console.error("[sre/custom-skills] failed to delete skill", error);
      return {
        error:
          "Failed to delete the skill. The skill store may not be configured.",
        success: false,
      };
    }
  },
  inputSchema: deleteSkillInputSchema,
});
