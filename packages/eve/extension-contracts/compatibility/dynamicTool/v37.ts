import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineTool({
        description: "Read a token with legacy provider ownership.",
        inputSchema: { type: "object", properties: {} },
        async execute(_input, ctx) {
          const token = await ctx.getToken({
            getToken: async () => ({ token: "fixture-token" }),
            principalType: "app",
          });
          return { token: token.token };
        },
      }),
  },
});
