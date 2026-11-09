import type { InMemoryFs } from "just-bash";

// A memory sandbox's workspace, kept where it outlives the sandbox: the files a session's shell and
// file tools wrote, restored when the session resumes (after a reload in a page, or on another
// host in the same process). One record per session, written whole after each change, which suits
// a sandbox in memory (small, written by one session at a time).

/** One entry of a workspace, by its absolute path in the sandbox. */
export type SandboxFileEntry =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly content: Uint8Array;
      readonly mode: number;
    }
  | { readonly kind: "directory"; readonly path: string; readonly mode: number }
  | { readonly kind: "symlink"; readonly path: string; readonly target: string };

/** Where memory sandboxes keep their sessions' workspaces. */
export interface SandboxFileStore {
  load(sessionId: string): Promise<readonly SandboxFileEntry[] | undefined>;
  save(sessionId: string, entries: readonly SandboxFileEntry[]): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

/** Workspaces in this realm's memory: what a realm without IndexedDB (Node, tests) keeps. */
export function createMemorySandboxFileStore(): SandboxFileStore {
  const workspaces = new Map<string, readonly SandboxFileEntry[]>();
  return {
    async load(sessionId) {
      return workspaces.get(sessionId);
    },
    async save(sessionId, entries) {
      workspaces.set(sessionId, entries);
    },
    async delete(sessionId) {
      workspaces.delete(sessionId);
    },
  };
}

/** Every entry of `fs` under `root`, parents before children. */
export async function snapshotWorkspace(
  fs: InMemoryFs,
  root: string,
): Promise<readonly SandboxFileEntry[]> {
  const paths = fs
    .getAllPaths()
    .filter((path) => path === root || path.startsWith(`${root}/`))
    .sort();
  const entries: SandboxFileEntry[] = [];
  for (const path of paths) {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink) {
      entries.push({ kind: "symlink", path, target: await fs.readlink(path) });
    } else if (stat.isDirectory) {
      entries.push({ kind: "directory", mode: stat.mode, path });
    } else {
      entries.push({ content: await fs.readFileBuffer(path), kind: "file", mode: stat.mode, path });
    }
  }
  return entries;
}

/** Writes `entries` into `fs`, as `snapshotWorkspace` read them. */
export async function restoreWorkspace(
  fs: InMemoryFs,
  entries: readonly SandboxFileEntry[],
): Promise<void> {
  for (const entry of entries) {
    if (entry.kind === "directory") {
      await fs.mkdir(entry.path, { recursive: true });
      await fs.chmod(entry.path, entry.mode);
    } else if (entry.kind === "file") {
      fs.writeFileSync(entry.path, entry.content, undefined, { mode: entry.mode });
    } else {
      await fs.symlink(entry.target, entry.path);
    }
  }
}
