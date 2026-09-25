import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
// The coding-agent setup and handoff prompts are composed at runtime from these
// section files (see cli/commands/agent-instructions.ts), so they must ship in
// the package next to the compiled module that reads them.
const runtimeAssetDirs = ["src/cli/commands/agent-prompt"];
// Built-in extension trees are discovered from dist, so their instructions and
// skills must ship beside the compiled modules.
const extensionAssetDirs = ["src/extensions/code/extension"];
// Hand-written declaration files are tsc inputs, not outputs. The ambient
// `workflow` module types are referenced from `eve/tools` and exported as
// `eve/workflow-modules`, so they ship beside the emitted declarations.
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
