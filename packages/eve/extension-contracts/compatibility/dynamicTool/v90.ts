// Epoch 90 of the dynamicTool capability: sandbox sessions typed from the AI SDK. Epoch 91 declares
// eve-owned session types with the same methods and adds `writeFiles`, which is additive.
import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "turn.started": () =>
      defineTool({
        description: "List Bob's report files.",
        inputSchema: { type: "object", properties: {} },
        async execute(_input, ctx) {
          const sandbox = await ctx.getSandbox();
          const result = await sandbox.run({
            command: "ls reports",
            workingDirectory: "/workspace",
          });
          return result.stdout.split("\n").filter(Boolean);
        },
      }),
  },
});
