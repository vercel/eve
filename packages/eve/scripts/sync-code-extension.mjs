/**
 * Copies the private `@eve/code` extension tree into `src/extensions/code/extension`
 * so eve compiles and ships it as the `eve/extensions/code` built-in extension.
 * `@eve/code` stays the source of truth; the copy is gitignored. eve cannot
 * depend on `@eve/code` (which depends on eve), so the sibling workspace path is
 * read directly and declared as a turbo input in `turbo.json`.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

export const codeExtensionTarget = join(packageRoot, "src", "extensions", "code", "extension");

export async function syncCodeExtension() {
  const source = join(packageRoot, "..", "eve-code", "extension");
  await rm(codeExtensionTarget, { recursive: true, force: true });
  await mkdir(dirname(codeExtensionTarget), { recursive: true });
  await cp(source, codeExtensionTarget, { recursive: true });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await syncCodeExtension();
}
