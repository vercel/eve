import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeAssets = [
  "src/cli/commands/init-agent-handoff.md",
  "src/cli/commands/init-agent-instructions.md",
];

export async function copyRuntimeAssets() {
  for (const relativePath of runtimeAssets) {
    const destinationPath = join(packageRoot, "dist", relativePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(join(packageRoot, relativePath), destinationPath);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await copyRuntimeAssets();
}
