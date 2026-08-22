import type {
  CompiledAgentNodeManifest,
  CompiledAgentResources,
  CompiledExtensionMount,
} from "#compiler/manifest.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

/** Collects every runtime-loaded module reference owned by one compiled node. */
export function collectModuleRefsForManifest(
  manifest: CompiledAgentNodeManifest | CompiledAgentResources,
): ModuleSourceRef[] {
  const refs = new Map<string, ModuleSourceRef>();

  if ("config" in manifest && manifest.config.source !== undefined) {
    refs.set(manifest.config.source.sourceId, manifest.config.source);
  }

  if ("config" in manifest && manifest.config.model?.source !== undefined) {
    refs.set(manifest.config.model.source.sourceId, manifest.config.model.source);
  }

  for (const channel of manifest.channels) {
    if (channel.kind === "disabled") continue;
    refs.set(channel.sourceId, toModuleRef(channel));
  }

  for (const connection of manifest.connections) {
    refs.set(connection.sourceId, toModuleRef(connection));
  }

  for (const tool of manifest.tools) {
    refs.set(tool.sourceId, toModuleRef(tool));
  }

  for (const dynamicInstructions of manifest.dynamicInstructions) {
    refs.set(dynamicInstructions.sourceId, toModuleRef(dynamicInstructions));
  }

  for (const dynamicSkill of manifest.dynamicSkills) {
    refs.set(dynamicSkill.sourceId, toModuleRef(dynamicSkill));
  }

  for (const dynamicTool of manifest.dynamicTools) {
    refs.set(dynamicTool.sourceId, toModuleRef(dynamicTool));
  }

  for (const remoteAgent of manifest.remoteAgents) {
    refs.set(remoteAgent.sourceId, toModuleRef(remoteAgent));
  }

  for (const hook of manifest.hooks) {
    refs.set(hook.sourceId, toModuleRef(hook));
  }

  for (const schedule of manifest.schedules) {
    if (schedule.sourceKind !== "module" || !schedule.hasRun) continue;
    refs.set(schedule.sourceId, toModuleRef(schedule));
  }

  if (manifest.sandbox !== null) {
    refs.set(manifest.sandbox.sourceId, toModuleRef(manifest.sandbox));
  }

  const extensionMounts = (manifest as { extensionMounts?: readonly CompiledExtensionMount[] })
    .extensionMounts;
  for (const mount of extensionMounts ?? []) {
    refs.set(mount.mountSourceId, {
      logicalPath: mount.mountLogicalPath,
      sourceId: mount.mountSourceId,
      sourceKind: "module",
    });
  }

  return [...refs.values()];
}

function toModuleRef(source: {
  readonly exportName?: string;
  readonly logicalPath: string;
  readonly sourceId: string;
}): ModuleSourceRef {
  return {
    exportName: source.exportName,
    logicalPath: source.logicalPath,
    sourceId: source.sourceId,
    sourceKind: "module",
  };
}
