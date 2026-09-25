/**
 * Copies the private `@eve/code` extension tree into `src/extensions/code/extension`
 * so eve compiles and ships it as the `eve/extensions/code` built-in extension.
 * `@eve/code` stays the source of truth; the copy is gitignored. eve cannot
 * depend on `@eve/code` (which depends on eve), so the sibling workspace path is
 * read directly and declared as a turbo input in `turbo.json`.
 */
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { acquireLock, releaseLock } from "./vendor-compiled/_shared.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const source = join(packageRoot, "..", "eve-code", "extension");

export const codeExtensionTarget = join(packageRoot, "src", "extensions", "code", "extension");

// Turbo runs several eve tasks at once and each one syncs; rewriting an
// identical tree would delete files a peer task is already compiling or testing.
export async function syncCodeExtension() {
  const lockPath = join(packageRoot, ".generated", "code-extension.lock");
  await mkdir(dirname(lockPath), { recursive: true });
  await acquireLock(lockPath);
  try {
    if (await sameTree(source, codeExtensionTarget)) return;
    await rm(codeExtensionTarget, { recursive: true, force: true });
    await mkdir(dirname(codeExtensionTarget), { recursive: true });
    await cp(source, codeExtensionTarget, { recursive: true });
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
  await syncCodeExtension();
}
