import { cp, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

export async function copyCompiledAssets() {
  const sourcePath = join(packageRoot, ".generated", "compiled");
  const destinationPath = join(packageRoot, "dist", "src", "compiled");

  try {
    await stat(sourcePath);
  } catch {
    throw new Error(
      `Missing compiled vendor assets at "${sourcePath}". Run "pnpm --filter eve build:compiled".`,
    );
  }

  await mkdir(dirname(destinationPath), {
    recursive: true,
  });
  await cp(sourcePath, destinationPath, {
    recursive: true,
    // Parallel vendor runs can release this coordination lock while we copy.
    filter: (source) => source !== join(sourcePath, ".vendor-lock"),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await copyCompiledAssets();
}
