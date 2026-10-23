// Epoch 91 of the dynamicTool capability. Epoch 92 makes the provider runtime behind
// `SandboxEnvironment` opaque and drops its unused configuration hash; dynamic tools that
// reach the sandbox through `ctx.getSandbox()` are unchanged, as this example shows.
import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "turn.started": () =>
      defineTool({
        description: "Read Bob's latest report.",
        inputSchema: { type: "object", properties: {} },
        async execute(_input, ctx) {
          const sandbox = await ctx.getSandbox();
          return await sandbox.readTextFile({ path: sandbox.resolvePath("reports/latest.md") });
        },
      }),
  },
});
