import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Inspect the current sandbox.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    return { sandboxAvailable: sandbox !== undefined };
  },
});
