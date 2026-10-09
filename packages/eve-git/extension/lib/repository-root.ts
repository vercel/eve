import type { SandboxSession } from "eve/sandbox";

import { shellQuote } from "./shell.ts";

type RootSandbox = Pick<SandboxSession, "resolvePath" | "run">;

const MAX_ERROR_DETAIL_CHARS = 2_000;

/** A workspace directory that must also be the top of a git work tree. */
export async function validateRepositoryRoot(sandbox: RootSandbox, root: string): Promise<string> {
  if (!root.startsWith("/")) throw new Error("root must be an absolute sandbox path");
  const workspace = await realPath(sandbox, sandbox.resolvePath(""), "sandbox workspace");
  const resolved = await realPath(sandbox, root, "root");
  const inside =
    workspace === "/" || resolved === workspace || resolved.startsWith(`${workspace}/`);
  if (!inside) throw new Error(`root resolves outside the workspace ${workspace}: ${resolved}`);
  const top = await sandbox.run({
    command: `git -C ${shellQuote(resolved)} rev-parse --show-toplevel`,
  });
  if (top.exitCode !== 0 || top.stdout.trim() !== resolved) {
    throw new Error(`root is not a git work tree root: ${root}`);
  }
  return resolved;
}

/** NUL-delimited output keeps paths that contain newlines unambiguous. */
async function realPath(sandbox: RootSandbox, path: string, label: string): Promise<string> {
  const result = await sandbox.run({ command: `realpath -e -z -- ${shellQuote(path)}` });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no command output";
    throw new Error(`${label} could not be resolved: ${detail.slice(0, MAX_ERROR_DETAIL_CHARS)}`);
  }
  const real = result.stdout.endsWith("\0") ? result.stdout.slice(0, -1) : result.stdout;
  if (real.length === 0 || real.includes("\0")) {
    throw new Error(`${label} returned an invalid realpath`);
  }
  return real;
}
