import type { RouteHandlerArgs } from "#channel/routes.js";

export function mockAgentRouteArgs(): Pick<
  RouteHandlerArgs,
  "describe" | "invokeTool" | "listSkillFiles" | "readSkill"
> {
  return {
    describe: async () => {
      throw new Error("describe() is unavailable in this test.");
    },
    invokeTool: async () => {
      throw new Error("invokeTool() is unavailable in this test.");
    },
    listSkillFiles: async () => {
      throw new Error("listSkillFiles() is unavailable in this test.");
    },
    readSkill: async () => {
      throw new Error("readSkill() is unavailable in this test.");
    },
  };
}
