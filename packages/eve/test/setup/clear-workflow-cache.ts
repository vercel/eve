import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Clears workflow and eve scratch state before the integration suite so
 * stale bundled step modules cannot replay against fresh test code.
 */
export default async function clearWorkflowCache(): Promise<void> {
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const cacheDirectories = [join(packageRoot, ".workflow-vitest"), join(packageRoot, ".eve")];

  await Promise.all(
    cacheDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
  );
}
