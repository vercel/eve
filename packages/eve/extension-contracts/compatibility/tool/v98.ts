import { defineTool } from "#public/tools/index.js";

// Existing tools can read scoped credentials without opting into event management.
export default defineTool({
  description: "Check whether the report service is connected.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const { token } = await ctx.getToken({
      principalType: "app",
      getToken: async () => ({ token: "service-credential" }),
    });
    return { connected: token.length > 0 };
  },
});
