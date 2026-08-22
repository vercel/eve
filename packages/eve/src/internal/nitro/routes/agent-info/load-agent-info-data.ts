import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import {
  type NitroArtifactsConfig,
  resolveNitroCompiledArtifactsSource,
} from "#internal/nitro/routes/runtime-artifacts.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";

/**
 * Runtime data needed to build the package-owned `GET /eve/v1/info`
 * inspection JSON.
 */
export interface AgentInfoData {
  readonly manifest: CompiledAgentManifest;
}

export type AgentInfoManifestData = AgentInfoData;

/**
 * Loads the compiled graph projected by `GET /eve/v1/info` without importing
 * or executing authored modules.
 */
export async function loadAgentInfoData(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Promise<AgentInfoData> {
  const manifest = await loadCompiledManifest({
    compiledArtifactsSource: input.compiledArtifactsSource,
  });
  return { manifest };
}

/**
 * Resolves the explicit runtime artifact source used by the package-owned
 * `GET /eve/v1/info` handler.
 */
export function resolveAgentInfoCompiledArtifactsSource(
  input: NitroArtifactsConfig,
): RuntimeCompiledArtifactsSource {
  return resolveNitroCompiledArtifactsSource(input);
}

export type { CompiledAgentManifest };
