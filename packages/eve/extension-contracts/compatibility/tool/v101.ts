// Epoch 101 of the tool capability. Epoch 102 makes the provider runtime behind
// `SandboxEnvironment` opaque and drops its unused configuration hash; tools that
// reach the sandbox through `ctx.getSandbox()` are unchanged, as this example shows.
import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Archive Alice's notes and pause the sandbox.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    await sandbox.writeFiles({
      files: [{ content: new TextEncoder().encode("Feed the cat."), path: "notes/alice.txt" }],
    });
    const result = await sandbox.run({ command: "tar -czf notes.tgz notes" });
    await sandbox.stop();
    return { exitCode: result.exitCode };
  },
});
