import { defineTool } from "#public/tools/index.js";

// Existing Connect auth providers still work without event support.
export default defineTool({
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
});
