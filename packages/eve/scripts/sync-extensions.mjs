/**
 * Copies the private extension packages into eve's `src/`
 * so eve compiles and ships them as built-in extensions: `@eve/code` becomes
 * `eve/extensions/code`, `@eve/git` becomes `eve/extensions/git`, and
 * `@eve/computer-use` becomes `eve/computer-use`. The
 * packages stay the source of truth; the copies are gitignored. eve cannot
 * depend on them (they depend on eve), so the sibling workspace paths are read
 * directly and declared as turbo inputs in `turbo.json`.
 */
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { acquireLock, releaseLock } from "./vendor-compiled/_shared.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

export const builtInExtensions = [
  {
    name: "code",
    source: join(packageRoot, "..", "eve-code", "extension"),
    target: join(packageRoot, "src", "extensions", "code", "extension"),
  },
  {
    name: "git",
    source: join(packageRoot, "..", "eve-git", "extension"),
    target: join(packageRoot, "src", "extensions", "git", "extension"),
  },
  {
    name: "computer-use",
    source: join(packageRoot, "..", "eve-computer-use", "extension"),
    target: join(packageRoot, "src", "computer-use", "extension"),
  },
];

// Turbo runs several eve tasks at once and each one syncs; rewriting an
// identical tree would delete files a peer task is already compiling or testing.
export async function syncExtensions() {
  for (const extension of builtInExtensions) await syncExtension(extension);
}

async function syncExtension({ name, source, target }) {
  const lockPath = join(packageRoot, ".generated", `${name}-extension.lock`);
  await mkdir(dirname(lockPath), { recursive: true });
  await acquireLock(lockPath);
  try {
    if (await sameTree(source, target)) return;
    await rm(target, { recursive: true, force: true });
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
  } finally {
    await releaseLock(lockPath);
  }
}

async function sameTree(left, right) {
  const [leftFiles, rightFiles] = await Promise.all([listFiles(left), listFiles(right)]);
  if (rightFiles === null || leftFiles.length !== rightFiles.length) return false;
  for (const [index, file] of leftFiles.entries()) {
    if (file !== rightFiles[index]) return false;
    const [a, b] = await Promise.all([readFile(join(left, file)), readFile(join(right, file))]);
    if (!a.equals(b)) return false;
  }
  return true;
}

async function listFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => null);
  if (entries === null) return null;
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await syncExtensions();
}
