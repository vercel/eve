import type { CompiledAgentManifest, CompiledSubagentNode } from "#compiler/manifest.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import {
  type NitroArtifactsConfig,
  resolveNitroCompiledArtifactsSource,
} from "#internal/nitro/routes/runtime-artifacts.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { resolveSchedules } from "#runtime/schedules/resolve-schedule.js";
import type { ResolvedScheduleDefinition } from "#runtime/types.js";

/**
 * Runtime data needed to build the package-owned `GET /eve/v1/info`
 * inspection JSON.
 */
export interface AgentInfoManifestData {
  readonly manifest: CompiledAgentManifest;
  readonly schedules: readonly ResolvedScheduleDefinition[];
}

/**
 * Loads manifest-only runtime data for inspection surfaces that must not
 * execute or import authored modules.
 */
export async function loadAgentInfoManifestData(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Promise<AgentInfoManifestData> {
  const manifest = await loadCompiledManifest({
    compiledArtifactsSource: input.compiledArtifactsSource,
  });
  const schedules = await resolveSchedules({
    manifest,
  });

  return {
    manifest,
    schedules,
  };
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

export type { CompiledAgentManifest, CompiledSubagentNode, ResolvedScheduleDefinition };
