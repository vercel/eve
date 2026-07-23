import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Inspect the current session and sandbox",
  inputSchema: { type: "object", properties: {} },
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    return {
      sandboxAvailable: sandbox !== undefined,
      sessionId: ctx.session.id,
      toolName: ctx.toolName,
    };
  },
});
