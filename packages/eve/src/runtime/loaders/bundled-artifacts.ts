import type { CompileMetadata } from "#compiler/artifact-contract.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import type { ModelMetadata } from "#internal/model-catalog.js";
import type { SandboxPreparedArtifactsManifest } from "#shared/sandbox-prepared-artifacts.js";
import {
  createRuntimeSession,
  getActiveRuntimeSession,
  setRuntimeSessionCompiledArtifacts,
  withRuntimeSession,
} from "#runtime/sessions/runtime-session.js";

export interface BundledCompiledArtifacts {
  manifest: CompiledAgentManifest;
  metadata?: CompileMetadata;
  modelMetadata?: ModelMetadata;
  moduleMap: CompiledModuleMap;
  sandboxPreparedArtifacts?: SandboxPreparedArtifactsManifest;
}

export interface WithBundledCompiledArtifactsInput extends BundledCompiledArtifacts {
  readonly sessionId?: string;
}

export function installBundledCompiledArtifacts(input: BundledCompiledArtifacts): void {
  setRuntimeSessionCompiledArtifacts(getActiveRuntimeSession(), {
    manifest: input.manifest,
    metadata: input.metadata,
    modelMetadata: input.modelMetadata,
    moduleMap: input.moduleMap,
    sandboxPreparedArtifacts: input.sandboxPreparedArtifacts,
  });
}

export async function withBundledCompiledArtifacts<T>(
  input: WithBundledCompiledArtifactsInput,
  fn: () => Promise<T> | T,
): Promise<T> {
  const session = createRuntimeSession(input.sessionId ?? "bundled-compiled-artifacts");

  return await withRuntimeSession(session, async () => {
    installBundledCompiledArtifacts(input);
    return await fn();
  });
}

export function readBundledCompiledArtifacts(): BundledCompiledArtifacts | null {
  return getActiveRuntimeSession().compiledArtifacts;
}
