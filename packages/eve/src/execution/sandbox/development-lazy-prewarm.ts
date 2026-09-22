import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeDiskCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadSandboxPreparedArtifact } from "#runtime/sandbox/prepared-artifacts.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { prewarmAppSandboxes } from "./prewarm.js";

const PREPARATION_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

/** Serializes whole-generation preparation across dev workers, rechecking artifacts under the lock. */
export async function ensureDevelopmentSandboxesPrepared(input: {
  readonly compiledArtifactsSource: RuntimeDiskCompiledArtifactsSource;
  readonly nodeId: string;
  readonly providerName: string;
}): Promise<void> {
  if ((await loadSandboxPreparedArtifact(input)) !== undefined) return;
  const source = input.compiledArtifactsSource;
  const { compileDirectoryPath } = resolveRuntimeCompilerArtifactPaths(source.appRoot);
  const lockPath = join(compileDirectoryPath, "sandbox-preparation.lock");
  const deadline = Date.now() + PREPARATION_WAIT_TIMEOUT_MS;
  await mkdir(compileDirectoryPath, { recursive: true });
  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          "Timed out waiting for development sandbox preparation. Restart eve dev to create a new development generation.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  try {
    if ((await loadSandboxPreparedArtifact(input)) !== undefined) return;
    await prewarmAppSandboxes({
      appRoot: source.sandboxAppRoot ?? source.appRoot,
      compiledArtifactsSource: source,
      log: (message) => console.info(message),
    });
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
