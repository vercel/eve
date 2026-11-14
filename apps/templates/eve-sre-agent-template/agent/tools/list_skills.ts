import { defineTool } from "eve/tools";
import { z } from "zod";
import { getCustomSkillStore, SkillStoreError } from "#lib/skills/store.ts";

export const listSkillsInputSchema = z.object({
  scope: z
    .enum(["all", "global", "user"])
    .default("all")
    .describe("The scope of skills to show."),
});

export default defineTool({
  description: "Read/list custom skills/runbooks.",
  async execute(input, ctx) {
    try {
      const store = getCustomSkillStore();
      const skills =
        input.scope === "all"
          ? [
              ...(await store.list(null, "global")),
              ...(await store.list(ctx.session.auth.current, "user")),
            ]
          : await store.list(
              input.scope === "global" ? null : ctx.session.auth.current,
              input.scope
            );
      return {
        count: skills.length,
        skills: skills.map(({ name, description, scope, updatedAt }) => ({
          description,
          name,
          scope,
          updatedAt,
        })),
        success: true,
      };
    } catch (error) {
      if (error instanceof SkillStoreError) {
        return { error: error.message, success: false };
      }
      console.error("[sre/custom-skills] failed to list skills", error);
      return {
        error: "Failed to list skills. The skill store may not be configured.",
        success: false,
      };
    }
  },
  inputSchema: listSkillsInputSchema,
});
