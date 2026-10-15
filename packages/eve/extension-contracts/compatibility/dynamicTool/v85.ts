import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 85 dynamic tools can use Connect auth without opting into event handling.
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
