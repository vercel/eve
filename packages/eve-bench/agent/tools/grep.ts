import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

import { resolveTaskPath, taskRoot } from "../task-path.js";

const execFileAsync = promisify(execFile);

export default defineTool({
  approval: never(),
  description:
    "Search task-environment text files with ripgrep and return matching lines with file names and line numbers.",
  inputSchema: z.object({
    pattern: z.string().describe("Regular expression accepted by ripgrep."),
    path: z
      .string()
      .optional()
      .describe("File or directory relative to the task working directory."),
    include: z.string().optional().describe("Optional glob restricting searched files."),
  }),
  async execute({ pattern, path, include }, ctx) {
    const args = ["--line-number", "--no-heading", "--color=never"];
    if (include !== undefined) args.push("--glob", include);
    args.push("--", pattern, path === undefined ? "." : resolveTaskPath(path));
    try {
      const { stdout, stderr } = await execFileAsync("rg", args, {
        cwd: taskRoot(),
        maxBuffer: 10 * 1024 * 1024,
        signal: ctx.abortSignal,
      });
      return { exitCode: 0, stderr, stdout };
    } catch (error) {
      const result = error as Error & { code?: number; stderr?: string; stdout?: string };
      const exitCode = typeof result.code === "number" ? result.code : 1;
      return {
        exitCode,
        stderr: result.stderr ?? (exitCode === 1 ? "" : result.message),
        stdout: result.stdout ?? "",
      };
    }
  },
});
