import { spawn } from "node:child_process";
import { constants } from "node:os";

import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

import { taskEnv, taskRoot } from "../task-path.ts";

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 1800;

export default defineTool({
  approval: never(),
  description: `Execute a shell command in the task environment. Commands start in the task working directory. A command that runs longer than timeoutSeconds (default ${DEFAULT_TIMEOUT_SECONDS}) is stopped with its child processes and returns exit code 124 with the output captured so far; raise timeoutSeconds for long builds, and start servers in the background.`,
  inputSchema: z.object({
    command: z.string().describe("The shell command to execute."),
    timeoutSeconds: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_SECONDS)
      .optional()
      .describe(`Seconds before the command is stopped. Default ${DEFAULT_TIMEOUT_SECONDS}.`),
  }),
  execute({ command, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS }, ctx) {
    return new Promise((resolve) => {
      // A separate process group lets a timeout stop everything the command started.
      const child = spawn("sh", ["-c", command], {
        cwd: taskRoot(),
        env: taskEnv(),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const output = { stdout: "", stderr: "" };
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      const collect = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
        const kept = chunk.subarray(0, Math.max(0, MAX_OUTPUT_BYTES - bytes));
        bytes += kept.length;
        output[stream] += kept.toString("utf8");
        if (kept.length < chunk.length) truncated = true;
      };
      child.stdout.on("data", collect("stdout"));
      child.stderr.on("data", collect("stderr"));
      const stop = () => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // The group already exited.
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutSeconds * 1000);
      ctx.abortSignal?.addEventListener("abort", stop, { once: true });
      let done = false;
      const finish = (exitCode: number, note?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.stdout.destroy();
        child.stderr.destroy();
        ctx.abortSignal?.removeEventListener("abort", stop);
        const notes = [
          note,
          timedOut ? `Command stopped after ${timeoutSeconds} seconds.` : undefined,
          truncated ? `Output truncated at ${MAX_OUTPUT_BYTES} bytes.` : undefined,
        ].filter(Boolean);
        resolve({
          exitCode: timedOut ? 124 : exitCode,
          stdout: output.stdout,
          stderr:
            notes.length > 0 ? `${output.stderr}\n[${notes.join(" ")}]`.trimStart() : output.stderr,
        });
      };
      const exitCode = (code: number | null, signal: NodeJS.Signals | null) =>
        code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0);
      child.on("error", (error) => finish(1, error.message));
      child.on("close", (code, signal) => finish(exitCode(code, signal)));
      // Background jobs can keep the pipes open after the shell exits; return with
      // what was captured instead of waiting for them.
      child.on("exit", (code, signal) => {
        setTimeout(() => finish(exitCode(code, signal)), 250);
      });
    });
  },
});
