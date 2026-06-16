import { extname } from "node:path";

import type { PackageManagerInvocation } from "./types.js";

export type StandardExecutablePackageManager = "bun" | "npm" | "yarn";

/** Resolves a manager executable, preserving test and package-runner interposition. */
export function resolveStandardInvocation(
  kind: StandardExecutablePackageManager,
  args: readonly string[],
): PackageManagerInvocation {
  const npmExecPath = process.env.npm_execpath;
  const lowered = npmExecPath?.toLowerCase();
  const matchesKind =
    lowered !== undefined &&
    (kind === "npm"
      ? lowered.includes("npm") && !lowered.includes("pnpm")
      : lowered.includes(kind));

  if (npmExecPath !== undefined && matchesKind) {
    const extension = extname(npmExecPath).toLowerCase();
    if (extension === ".cjs" || extension === ".js") {
      return { args: [npmExecPath, ...args], command: process.execPath };
    }
    return { args, command: npmExecPath, shell: process.platform === "win32" };
  }

  return { args, command: kind, shell: process.platform === "win32" };
}

export async function applyNoProjectConfiguration(): Promise<{
  filesSkipped: [];
  filesWritten: [];
}> {
  return { filesSkipped: [], filesWritten: [] };
}
