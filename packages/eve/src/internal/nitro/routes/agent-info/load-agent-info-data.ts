import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import {
  type NitroArtifactsConfig,
  resolveNitroCompiledArtifactsSource,
} from "#internal/nitro/routes/runtime-artifacts.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";

/**
 * Manifest-only runtime data projected by `GET /eve/v1/info`. Inspection
 * never executes or imports authored modules.
 */
export interface AgentInfoManifestData {
  readonly manifest: CompiledAgentManifest;
}

/**
 * Loads the compiled manifest for inspection surfaces that must not
 * execute or import authored modules.
 */
export async function loadAgentInfoManifestData(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Promise<AgentInfoManifestData> {
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
