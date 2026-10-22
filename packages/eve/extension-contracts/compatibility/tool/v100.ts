// Epoch 100 of the tool capability: sandbox sessions typed from the AI SDK. Epoch 101 declares
// eve-owned session types with the same methods and adds `writeFiles`, which is additive.
import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Summarize Alice's notes in the sandbox.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    const env: Record<string, string> = { NOTES_OWNER: "alice" };
    await sandbox.writeTextFile({ content: "Feed the cat.", path: "notes/alice.txt" });
    const result = await sandbox.run({ command: "wc -w notes/alice.txt", env });
    const text = await sandbox.readTextFile({ path: "notes/alice.txt", startLine: 1 });
    return { exitCode: result.exitCode, text, words: result.stdout.trim() };
  },
});
