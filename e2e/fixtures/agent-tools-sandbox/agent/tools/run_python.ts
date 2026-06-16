import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Authored tool that runs real Python inside the sandbox via the
 * `ctx.getSandbox()` runtime API — the headline authored-sandbox path from
 * the docs. It writes a generated script with `writeTextFile`, executes it
 * with `run`, and returns the parsed result, exercising `getSandbox`,
 * `writeTextFile`, and `run` together against a real backend.
 *
 * The computation is deterministic given its input (the sum of the supplied
 * integers) so the eval can assert an exact value while still proving the
 * Python interpreter actually executed.
 */
export default defineTool({
  description:
    "Smoke-test fixture: sums a list of integers by writing and executing a Python script in the sandbox. Only call when the user explicitly asks to use `run_python`.",
  inputSchema: z.object({
    numbers: z.array(z.number().int()).min(1).describe("Integers to sum."),
  }),
  async execute({ numbers }, ctx) {
    const sandbox = await ctx.getSandbox();
    const script = [
      "import json",
      `nums = json.loads(${JSON.stringify(JSON.stringify(numbers))})`,
      "print(sum(nums))",
      "",
    ].join("\n");
    const scriptPath = "run_python_sum.py";
    await sandbox.writeTextFile({ path: scriptPath, content: script });
    const result = await sandbox.run({ command: `python ${sandbox.resolvePath(scriptPath)}` });
    if (result.exitCode !== 0) {
      throw new Error(`run_python: python exited ${result.exitCode}: ${result.stderr}`);
    }
    return { sum: Number.parseInt(result.stdout.trim(), 10) };
  },
});
