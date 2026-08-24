import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import {
  type NitroArtifactsConfig,
  resolveNitroCompiledArtifactsSource,
} from "#internal/nitro/routes/runtime-artifacts.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";

/** Serialized compiler authority needed to project `GET /eve/v1/info`. */
export interface AgentInfoManifestData {
  readonly manifest: CompiledAgentManifest;
}

/** Loads inspection data without importing or executing authored modules. */
export async function loadAgentInfoManifestData(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Promise<AgentInfoManifestData> {
  return {
    manifest: await loadCompiledManifest({
      compiledArtifactsSource: input.compiledArtifactsSource,
    }),
  };
}

/** Resolves the compiled artifact source used by the package-owned info route. */
export function resolveAgentInfoCompiledArtifactsSource(
  input: NitroArtifactsConfig,
): RuntimeCompiledArtifactsSource {
  return resolveNitroCompiledArtifactsSource(input);
}
