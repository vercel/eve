import { shellQuote } from "#execution/sandbox/shell-quote.js";

export interface WorkspaceSandbox {
  resolvePath(path: string): string;
  run(input: {
    signal?: AbortSignal;
    command: string;
  }): PromiseLike<{ exitCode: number; stderr: string; stdout: string }>;
}

const MAX_ERROR_DETAIL_CHARS = 2_000;

async function sandboxRealPath(
  sandbox: WorkspaceSandbox,
  path: string,
  label: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const result = await sandbox.run({
    signal: abortSignal,
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
