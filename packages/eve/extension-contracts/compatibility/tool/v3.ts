import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Read from an allow-listed service",
  inputSchema: { type: "object", properties: {} },
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    await sandbox.setNetworkPolicy({ allow: ["api.example.com"] });
    return { status: "ready" };
  },
});
