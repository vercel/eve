// Epoch 87 of the dynamicTool capability: the authoring contract of epoch 86 still compiles.
// Epoch 88 adds an optional `windows` usage field to subagent results.
import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "session.started": () => ({
      authorization: defineTool({
        description: "Check that the issue service is authorized.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        async execute(_input, ctx) {
          const { token } = await ctx.getToken({
            principalType: "app",
            getToken: async () => ({ token: "service-credential" }),
            vercelConnect: { connector: "oauth/issues" },
          });
          return { authorized: token.length > 0 };
        },
      }),
    }),
  },
});
