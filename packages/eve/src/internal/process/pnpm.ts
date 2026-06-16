import { existsSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * Resolved invocation for the host's pnpm executable. The shape carries
 * everything `child_process.spawn` and `execFile` need to dispatch to the
 * right binary across macOS/Linux PATH installs, Corepack-managed shims,
 * and Windows runners that surface pnpm only through `PNPM_HOME`.
 */
export interface PnpmInvocation {
  readonly args: readonly string[];
  readonly command: string;
  readonly shell?: boolean;
}

/**
 * Picks the right pnpm executable for the current host. Resolution order:
 *
 *  1. `PNPM_HOME` — the standard install location used by Corepack and the
 *     pnpm installers. On Windows, points at `pnpm.CMD` because the bare
 *     `pnpm` shim is not directly invokable from a non-shell spawn.
 *  2. `npm_execpath` — set when the current process was launched by an
 *     npm-compatible package manager. Pointing at a `.cjs`/`.js` entry
 *     means we have to run it through `node` (typical for Corepack
 *     shims); otherwise treat it as a bare executable path.
 *  3. Bare `pnpm` on PATH — the macOS/Linux happy path.
 *
 * Pure: no side effects, returns the invocation shape; the caller picks
 * `spawn` vs. `execFile`. The test harness uses this to keep platform
 * handling in one place.
 */
export function resolvePnpmInvocation(args: readonly string[]): PnpmInvocation {
  const pnpmHome = process.env.PNPM_HOME;

  if (pnpmHome !== undefined) {
    const command = join(pnpmHome, process.platform === "win32" ? "pnpm.CMD" : "pnpm");

    if (existsSync(command)) {
      return {
        args,
        command,
        shell: process.platform === "win32",
      };
    }
  }

  const npmExecPath = process.env.npm_execpath;

  if (npmExecPath !== undefined && npmExecPath.toLowerCase().includes("pnpm")) {
    const extension = extname(npmExecPath).toLowerCase();

    if (extension === ".cjs" || extension === ".js") {
      return {
        args: [npmExecPath, ...args],
        command: process.execPath,
      };
    }

    return {
      args,
      command: npmExecPath,
      shell: process.platform === "win32",
    };
  }

  return {
    args,
    command: "pnpm",
  };
}
