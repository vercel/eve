import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Read a token with retained epoch 42 provider ownership.",
  inputSchema: { type: "object", properties: {} },
  async execute(_input, ctx) {
    const token = await ctx.getToken({
      getToken: async () => ({ token: "fixture-token" }),
      principalType: "app",
    });
    return { token: token.token };
  },
});
