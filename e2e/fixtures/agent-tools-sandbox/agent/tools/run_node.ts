import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Authored tool that runs a Node script inside the sandbox via the
 * `ctx.getSandbox()` runtime API. It writes a generated script with
 * `writeTextFile`, executes it with `run`, and returns the parsed result,
 * exercising the full authored-sandbox path against a real backend.
 */
export default defineTool({
  description:
    "Smoke-test fixture: sums a list of integers by writing and executing a Node script in the sandbox. Only call when the user explicitly asks to use `run_node`.",
  inputSchema: z.object({
    numbers: z.array(z.number().int()).min(1).describe("Integers to sum."),
  }),
  async execute({ numbers }, ctx) {
    const sandbox = await ctx.getSandbox();
    const script = [
      `const numbers = ${JSON.stringify(numbers)};`,
      "console.log(numbers.reduce((sum, number) => sum + number, 0));",
      "",
    ].join("\n");
    const scriptPath = "run_node_sum.mjs";
    await sandbox.writeTextFile({ path: scriptPath, content: script });
    const result = await sandbox.run({ command: `node ${sandbox.resolvePath(scriptPath)}` });
    if (result.exitCode !== 0) {
      throw new Error(`run_node: node exited ${result.exitCode}: ${result.stderr}`);
    }
    return { sum: Number.parseInt(result.stdout.trim(), 10) };
  },
});
