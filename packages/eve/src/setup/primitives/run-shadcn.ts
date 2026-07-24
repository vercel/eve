import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function findLocalShadcn(cwd: string): string | undefined {
  let directory = resolve(cwd);
  const executable = process.platform === "win32" ? "shadcn.cmd" : "shadcn";
  while (true) {
    const candidate = join(directory, "node_modules", ".bin", executable);
    try {
      accessSync(candidate, constants.F_OK | constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Keep looking through ancestor projects.
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Resolves the project-local shadcn CLI, falling back to npx when absent. */
export function resolveShadcnInvocation(cwd: string, args: readonly string[]) {
  const local = findLocalShadcn(cwd);
  if (local !== undefined) return { command: local, args, shell: process.platform === "win32" };
  return {
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["--yes", "shadcn@latest", ...args],
    shell: process.platform === "win32",
  };
}

/** Runs shadcn from the agent project, preserving all shadcn arguments. */
export function runShadcn(
  args: readonly string[],
  options: { cwd: string; signal?: AbortSignal },
): Promise<boolean> {
  if (options.signal?.aborted) return Promise.resolve(false);
  const invocation = resolveShadcnInvocation(options.cwd, args);
  return new Promise((resolvePromise) => {
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: existsSync(options.cwd) ? options.cwd : process.cwd(),
      shell: invocation.shell,
      signal: options.signal,
      stdio: "inherit",
    });
    child.once("error", () => resolvePromise(false));
    child.once("close", (code) => resolvePromise(options.signal?.aborted !== true && code === 0));
  });
}
