import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export default async function clearWorkflowCache(): Promise<void> {
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const cacheDirectories = [join(packageRoot, ".workflow-vitest"), join(packageRoot, ".eve")];

  await Promise.all(
    cacheDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
  );
}
