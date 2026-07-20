import type { CompiledAgentManifest, CompiledSubagentNode } from "#compiler/manifest.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import {
  type NitroArtifactsConfig,
  resolveNitroCompiledArtifactsSource,
} from "#internal/nitro/routes/runtime-artifacts.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { loadCompiledModuleMap } from "#runtime/loaders/module-map.js";
import { resolveAgent } from "#runtime/resolve-agent.js";
import { resolveSchedules } from "#runtime/schedules/resolve-schedule.js";
import type {
  ResolvedAgent,
  ResolvedSandboxDefinition,
  ResolvedScheduleDefinition,
  ResolvedSkillDefinition,
  ResolvedInstructionsDefinition,
} from "#runtime/types.js";

/**
 * Runtime data needed to build the package-owned `GET /eve/v1/info`
 * inspection JSON.
 */
export interface AgentInfoData {
  readonly agent: ResolvedAgent;
  readonly manifest: CompiledAgentManifest;
  readonly schedules: readonly ResolvedScheduleDefinition[];
}

export interface AgentInfoManifestData {
  readonly manifest: CompiledAgentManifest;
  readonly schedules: readonly ResolvedScheduleDefinition[];
}

/**
 * Loads the resolved runtime data projected by `GET /eve/v1/info`.
 */
export async function loadAgentInfoData(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Promise<AgentInfoData> {
  return await loadAgentInfoDataFromArtifacts(input.compiledArtifactsSource);
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

async function loadAgentInfoDataFromArtifacts(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): Promise<AgentInfoData> {
  const [manifest, moduleMap] = await Promise.all([
    loadCompiledManifest({
      compiledArtifactsSource,
    }),
    loadCompiledModuleMap({
      compiledArtifactsSource,
    }),
  ]);
  const schedules = await resolveSchedules({
    manifest,
  });

  return {
    agent: await resolveAgent({
      manifest,
      moduleMap,
    }),
    manifest,
    schedules,
  };
}

export type {
  CompiledAgentManifest,
  CompiledSubagentNode,
  ResolvedSandboxDefinition,
  ResolvedScheduleDefinition,
  ResolvedSkillDefinition,
  ResolvedInstructionsDefinition,
};
