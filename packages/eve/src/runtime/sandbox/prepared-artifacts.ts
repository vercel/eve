import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { readBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import {
  createSandboxPreparedArtifactsManifest,
  sandboxPreparedArtifactsManifestSchema,
  type SandboxPreparedArtifactEntry,
  type SandboxPreparedArtifactsManifest,
} from "#shared/sandbox-prepared-artifacts.js";
import type { SandboxPreparedArtifact } from "#shared/sandbox-provider.js";

export async function writeSandboxPreparedArtifactsManifest(input: {
  readonly compileDirectoryPath: string;
  readonly entries: readonly SandboxPreparedArtifactEntry[];
}): Promise<void> {
  if (input.entries.length === 0) return;
  const path = `${input.compileDirectoryPath}/sandbox-prepared-artifacts.json`;
  let existing: SandboxPreparedArtifactsManifest | null = null;
  try {
    existing = sandboxPreparedArtifactsManifestSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const entries = new Map(existing?.entries.map((entry) => [entry.nodeId, entry]));
  for (const entry of input.entries) entries.set(entry.nodeId, entry);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(createSandboxPreparedArtifactsManifest([...entries.values()]), null, 2)}\n`,
    );
    // Dev workers may read while another worker publishes the prepared generation.
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function loadSandboxPreparedArtifact(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId: string;
  readonly providerName: string;
}): Promise<SandboxPreparedArtifact | undefined> {
  const manifest = await loadSandboxPreparedArtifactsManifest(input.compiledArtifactsSource);
  const entry = manifest?.entries.find((candidate) => candidate.nodeId === input.nodeId);
  if (entry !== undefined && entry.providerName !== input.providerName) {
    throw new Error(
      `Prepared sandbox artifact for node "${input.nodeId}" belongs to provider "${entry.providerName}", not "${input.providerName}".`,
    );
  }
  return entry?.artifact;
}

async function loadSandboxPreparedArtifactsManifest(
  source: RuntimeCompiledArtifactsSource,
): Promise<SandboxPreparedArtifactsManifest | null> {
  if (source.kind === "bundled") {
    return readBundledCompiledArtifacts()?.sandboxPreparedArtifacts ?? null;
  }
  const path = resolveRuntimeCompilerArtifactPaths(source.appRoot).sandboxPreparedArtifactsPath;
  try {
    return sandboxPreparedArtifactsManifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
