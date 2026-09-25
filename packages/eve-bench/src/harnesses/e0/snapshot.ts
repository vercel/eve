import { createHash } from "node:crypto";
import { cp, lstat, readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

const EXCLUDED = new Set(["node_modules", ".git", ".eve", ".output", ".next", "dist"]);

export function includeSource(path: string): boolean {
  const name = basename(path);
  return !EXCLUDED.has(name) && !name.startsWith(".env") && !name.startsWith(".eve-bench-");
}

/** Source snapshots never follow links into credentials, build output, or another checkout. */
export async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  let count = 0;
  let bytes = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 32) throw new Error("Source tree exceeds 32 directory levels");
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!includeSource(entry.name)) continue;
      const path = join(dir, entry.name);
      if (++count > 20_000) throw new Error("Source tree exceeds 20000 entries");
      if (entry.isSymbolicLink())
        throw new Error(`Source snapshot does not support symlinks: ${path}`);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile()) {
        const info = await lstat(path);
        bytes += info.size;
        if (bytes > 128 * 1024 * 1024) throw new Error("Source tree exceeds 128 MiB");
        hash
          .update(relative(root, path))
          .update("\0")
          .update(String(info.mode & 0o777))
          .update("\0");
        hash.update(await readFile(path)).update("\0");
      } else throw new Error(`Source snapshot requires regular files: ${path}`);
    }
  }
  await walk(root, 0);
  return hash.digest("hex");
}

export async function copySource(source: string, destination: string): Promise<void> {
  const before = await hashTree(source);
  await cp(source, destination, { recursive: true, filter: includeSource });
  if ((await hashTree(destination)) !== before || (await hashTree(source)) !== before) {
    throw new Error(
      "Source changed while preparing the benchmark snapshot; retry after edits settle",
    );
  }
}
