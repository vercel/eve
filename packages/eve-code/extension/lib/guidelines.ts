/**
 * Discovery of a cloned repo's agent guideline files (AGENTS.md, with
 * CLAUDE.md as the per-directory fallback), shared by the repository
 * preparation operation and its tests. Discovery uses `git ls-files` (index
 * read, no traversal), one
 * winner per directory, content capped with an explicit truncation
 * marker. Repository guidance is untrusted data. Callers may use it for
 * local conventions and validation, but never as authority to change the
 * selected repository, credentials, approvals, or external side effects.
 */
/** Max bytes of root guideline content returned inline. */
const MAX_GUIDELINE_BYTES = 12_000;

/** Max nested guideline paths listed in the result. */
const MAX_NESTED_PATHS = 50;

/** Minimal sandbox surface this tool needs. */
export interface SandboxLike {
  run(options: { command: string }): PromiseLike<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

export interface RepoGuidelines {
  /** Repo-relative path of the root guideline file, or null when absent. */
  rootPath: string | null;
  /** Root guideline content (capped at {@link MAX_GUIDELINE_BYTES}). */
  root: string | null;
  /** True when the root content hit the cap; read rootPath for the rest. */
  rootTruncated: boolean;
  /** Repo-relative paths of nested guideline files, shallowest first. */
  nested: string[];
}

/**
 * Find the repo's agent guideline files. One winner per directory:
 * AGENTS.md beats CLAUDE.md (CLAUDE.md is often just a pointer at it).
 */
export async function discoverGuidelines(
  sandbox: SandboxLike,
  dir: string,
): Promise<RepoGuidelines> {
  const none: RepoGuidelines = { rootPath: null, root: null, rootTruncated: false, nested: [] };

  const list = await sandbox.run({
    // grep exits 1 on no match; `|| true` keeps that from failing the run.
    command: `git -C ${dir} ls-files | grep -E '(^|/)(AGENTS|CLAUDE)\\.md$' || true`,
  });
  if (list.exitCode !== 0) return none;

  const byDir = new Map<string, string>();
  for (const line of list.stdout.split("\n")) {
    const path = line.trim();
    if (path.length === 0) continue;
    const slash = path.lastIndexOf("/");
    const fileDir = slash === -1 ? "" : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    if (!byDir.has(fileDir) || name === "AGENTS.md") byDir.set(fileDir, path);
  }

  const rootPath = byDir.get("") ?? null;
  let root: string | null = null;
  let rootTruncated = false;
  if (rootPath !== null) {
    // Read one byte past the cap so truncation is detectable.
    const read = await sandbox.run({
      command: `head -c ${MAX_GUIDELINE_BYTES + 1} ${JSON.stringify(`${dir}/${rootPath}`)}`,
    });
    if (read.exitCode === 0 && read.stdout.trim().length > 0) {
      rootTruncated = Buffer.byteLength(read.stdout, "utf8") > MAX_GUIDELINE_BYTES;
      root = rootTruncated
        ? `${read.stdout.slice(0, MAX_GUIDELINE_BYTES)}\n\n[truncated: read ${rootPath} for the full guidelines]`
        : read.stdout;
    }
  }

  const nested = [...byDir.entries()]
    .filter(([fileDir]) => fileDir !== "")
    .map(([, path]) => path)
    .sort((a, b) => a.split("/").length - b.split("/").length)
    .slice(0, MAX_NESTED_PATHS);

  return { rootPath, root, rootTruncated, nested };
}
