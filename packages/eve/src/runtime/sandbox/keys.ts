import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  getRuntimeCompiledArtifactsCacheKey,
  getRuntimeCompiledArtifactsSandboxAppRoot,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { loadCompileMetadata } from "#runtime/loaders/compile-metadata.js";
import { resolveVercelProjectIdFromEnvironment } from "#shared/vercel-project.js";

const RUNTIME_SANDBOX_CONTRACT_VERSION = 9;

/**
 * Derives eve's private compatibility revision for one sandbox definition.
 */
export async function createRuntimeSandboxDefinitionRevision(input: {
  readonly nodeId: string;
  readonly sourceHash: string;
  readonly sourceId: string;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
}): Promise<string> {
  return createStableHash(
    [
      RUNTIME_SANDBOX_CONTRACT_VERSION,
      input.nodeId,
      input.sourceId,
      input.sourceHash,
      input.workspaceResourceRoot.contentHash ?? "",
    ].join(":"),
  );
}

/**
 * Derives the internal provider resource name for one agent session.
 */
export async function createRuntimeSandboxSessionKey(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId: string;
  readonly revision: string;
  readonly sessionId: string;
}): Promise<string> {
  const scope = await resolveRuntimeSandboxScope(input.compiledArtifactsSource);
  return sanitizeRuntimeSandboxKey(
    `eve-sbx-ses-${scope}-${input.revision.slice(0, 12)}-${input.sessionId}-${input.nodeId}`,
  );
}

/**
 * Derives the private build identity for one exported provider template.
 */
export async function createRuntimeSandboxTemplateKey(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly exportName: string;
  readonly implementationId: string;
  readonly nodeId: string;
  readonly revision: string;
}): Promise<string> {
  const [metadata, scope] = await Promise.all([
    loadCompileMetadataForKeys(input.compiledArtifactsSource),
    resolveRuntimeSandboxScope(input.compiledArtifactsSource),
  ]);
  const packageVersion = metadata?.generator.version ?? resolveInstalledPackageInfo().version;
  const hash = createStableHash(
    [
      packageVersion,
      RUNTIME_SANDBOX_CONTRACT_VERSION,
      input.implementationId,
      input.revision,
      input.nodeId,
      input.exportName,
    ].join(":"),
  ).slice(0, 20);
  return sanitizeRuntimeSandboxKey(`eve-sbx-tpl-${scope}-${hash}`);
}

async function loadCompileMetadataForKeys(compiledArtifactsSource: RuntimeCompiledArtifactsSource) {
  try {
    return await loadCompileMetadata({ compiledArtifactsSource });
  } catch {
    return null;
  }
}

async function resolveRuntimeSandboxScope(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): Promise<string> {
  const projectId = resolveVercelProjectIdFromEnvironment();
  if (projectId !== undefined) {
    return createStableHash(`vercel-project:${projectId}`).slice(0, 16);
  }

  const appRoot = getRuntimeCompiledArtifactsSandboxAppRoot(compiledArtifactsSource);
  if (appRoot !== undefined) {
    return createStableHash(await realpath(appRoot)).slice(0, 16);
  }

  return createStableHash(getRuntimeCompiledArtifactsCacheKey(compiledArtifactsSource)).slice(
    0,
    16,
  );
}

function createStableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeRuntimeSandboxKey(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
}
