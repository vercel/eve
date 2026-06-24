import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
// The coding-agent setup and handoff prompts are composed at runtime from these
// section files (see cli/commands/agent-instructions.ts), so they must ship in
// the package next to the compiled module that reads them.
const runtimeAssetDirs = ["src/cli/commands/agent-prompt"];

export async function copyRuntimeAssets() {
  for (const relativePath of runtimeAssetDirs) {
    const destinationPath = join(packageRoot, "dist", relativePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await cp(join(packageRoot, relativePath), destinationPath, { recursive: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await copyRuntimeAssets();
}
