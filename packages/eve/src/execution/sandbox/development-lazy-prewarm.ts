import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  acquireRecoveryLease,
  startPublicationJournalHeartbeat,
} from "#internal/application/output-publication-lock.js";
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
  const token = randomUUID();
  let lease;
  while ((lease = await acquireRecoveryLease(lockPath, token)) === undefined) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${PREPARATION_WAIT_TIMEOUT_MS / 60_000} minutes waiting for another request or eve dev worker to prepare sandbox environments ` +
          `(this request needs provider "${input.providerName}"). ` +
          "Check the eve dev output or run `eve logs` to see which step is slow, such as an image pull, a Dockerfile build, or a `prepare` callback. " +
          "Retry after preparation finishes, or restart eve dev to cancel it.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // Workers share the parent's pid: heartbeat expiry, not pid alone, detects a crashed worker.
  const stopHeartbeat = startPublicationJournalHeartbeat(join(lockPath, "lease"));
  try {
    if ((await loadSandboxPreparedArtifact(input)) !== undefined) return;
    await prewarmAppSandboxes({
      appRoot: source.sandboxAppRoot ?? source.appRoot,
      compiledArtifactsSource: source,
      log: (message) => console.info(message),
    });
  } finally {
    stopHeartbeat();
    await lease.complete();
  }
}
