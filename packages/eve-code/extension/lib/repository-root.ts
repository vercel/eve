import { shellQuote } from "./shell.ts";
import { resolveWorkspaceDirectory, type WorkspaceSandbox } from "./workspace-root.ts";

/** A workspace directory that must also be the top of a git work tree. */
export async function validateRepositoryRoot(
  sandbox: WorkspaceSandbox,
  root: string,
): Promise<string> {
  const resolved = await resolveWorkspaceDirectory(sandbox, root);
  const top = await sandbox.run({
    command: `git -C ${shellQuote(resolved)} rev-parse --show-toplevel`,
  });
  if (top.exitCode !== 0 || top.stdout.trim() !== resolved) {
    throw new Error(`root is not a git work tree root: ${root}`);
  }
  return resolved;
}
