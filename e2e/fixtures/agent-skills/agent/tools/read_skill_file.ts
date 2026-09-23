import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Read a supporting file from a loaded skill package by skill name and relative path.",
  inputSchema: z.object({
    skill: z.string().describe("Skill name, for example dynamic-tenant-policy."),
    path: z
      .string()
      .describe("Path relative to the skill directory, for example references/policy.md."),
  }),
  execute: async (input, ctx) => await ctx.getSkill(input.skill).file(input.path).text(),
});
