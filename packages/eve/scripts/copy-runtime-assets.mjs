import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeAssetDirs = ["src/cli/commands/agent-prompt"];
const extensionAssetDirs = [
  "src/extensions/code/extension",
  "src/extensions/git/extension",
  "src/computer-use/extension",
];
const runtimeAssetFiles = ["src/public/workflow-modules.d.ts"];

export async function copyRuntimeAssets() {
  for (const relativePath of [...runtimeAssetDirs, ...runtimeAssetFiles]) {
    const destinationPath = join(packageRoot, "dist", relativePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await cp(join(packageRoot, relativePath), destinationPath, { recursive: true });
  }
  for (const relativePath of extensionAssetDirs) {
    await cp(join(packageRoot, relativePath), join(packageRoot, "dist", relativePath), {
      recursive: true,
      filter: (path) => !path.endsWith(".ts"),
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await copyRuntimeAssets();
}
