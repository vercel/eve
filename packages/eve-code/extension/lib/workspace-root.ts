import { shellQuote } from "./shell.ts";

/**
 * The single containment check for sandbox paths that tools read or write.
 * The workspace root differs by provider (`/workspace`, `/app`, ...), so the
 * boundary is the real path of `resolvePath("")`, never a literal prefix.
 */
export interface WorkspaceSandbox {
  resolvePath(path: string): string;
  run(input: {
    abortSignal?: AbortSignal;
    command: string;
  }): PromiseLike<{ exitCode: number; stderr: string; stdout: string }>;
}

const MAX_ERROR_DETAIL_CHARS = 2_000;

/** NUL-delimited output keeps paths that contain newlines unambiguous. */
export async function sandboxRealPath(
  sandbox: WorkspaceSandbox,
  path: string,
  label: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const result = await sandbox.run({
    abortSignal,
    command: `realpath -e -z -- ${shellQuote(path)}`,
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no command output";
    throw new Error(`${label} could not be resolved: ${detail.slice(0, MAX_ERROR_DETAIL_CHARS)}`);
  }
  const realPath = result.stdout.endsWith("\0") ? result.stdout.slice(0, -1) : result.stdout;
  if (realPath.length === 0 || realPath.includes("\0")) {
    throw new Error(`${label} returned an invalid realpath`);
  }
  return realPath;
}

/**
 * Resolves `path` (default: the workspace root) to a real path inside the real
 * workspace. Symlinks are followed before the check, so a link cannot escape.
 */
export async function resolveInWorkspace(
  sandbox: WorkspaceSandbox,
  path: string | undefined,
  label: string,
  abortSignal?: AbortSignal,
): Promise<{ readonly path: string; readonly workspace: string }> {
  const workspace = await sandboxRealPath(
    sandbox,
    sandbox.resolvePath(""),
    "sandbox workspace",
    abortSignal,
  );
  if (path === undefined) return { path: workspace, workspace };
  const real = await sandboxRealPath(sandbox, path, label, abortSignal);
  const inside = workspace === "/" || real === workspace || real.startsWith(`${workspace}/`);
  if (!inside) throw new Error(`${label} resolves outside the workspace ${workspace}: ${real}`);
  return { path: real, workspace };
}

/**
 * An absolute directory inside the workspace (default: the workspace root).
 * Git is not required; `validateRepositoryRoot` adds that check.
 */
export async function resolveWorkspaceDirectory(
  sandbox: WorkspaceSandbox,
  root?: string,
): Promise<string> {
  if (root !== undefined && !root.startsWith("/")) {
    throw new Error("root must be an absolute sandbox path");
  }
  return (await resolveInWorkspace(sandbox, root, "root")).path;
}
