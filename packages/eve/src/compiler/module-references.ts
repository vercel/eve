import type { CompiledAgentNodeManifest } from "#compiler/manifest.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

/**
 * The complete module-bearing portion of a compiled node.
 */
export interface CompiledModuleReferenceSource {
  readonly channelRoutes: CompiledAgentNodeManifest["channelRoutes"];
  readonly config?: CompiledAgentNodeManifest["config"];
  readonly connections: readonly CompiledAgentNodeManifest["connections"][number][];
  readonly dynamicInstructions: readonly CompiledAgentNodeManifest["dynamicInstructions"][number][];
  readonly dynamicSkills: readonly CompiledAgentNodeManifest["dynamicSkills"][number][];
  readonly dynamicTools: readonly CompiledAgentNodeManifest["dynamicTools"][number][];
  readonly extensionMounts: readonly CompiledAgentNodeManifest["extensionMounts"][number][];
  readonly hooks: readonly CompiledAgentNodeManifest["hooks"][number][];
  readonly instrumentation: CompiledAgentNodeManifest["instrumentation"];
  readonly sandbox: CompiledAgentNodeManifest["sandbox"];
  readonly schedules: readonly CompiledAgentNodeManifest["schedules"][number][];
  readonly tools: readonly CompiledAgentNodeManifest["tools"][number][];
}

/** Collects every runtime-loaded module reference owned by one compiled node. */
export function collectModuleRefsForManifest(
  manifest: CompiledModuleReferenceSource,
): ModuleSourceRef[] {
  const refs: ModuleSourceRef[] = [];

  if (manifest.config !== undefined) {
    refs.push(manifest.config.source);
  }

  if (manifest.config?.model?.source !== undefined) {
    refs.push(manifest.config.model.source);
  }

  if (manifest.config?.compaction?.model?.source !== undefined) {
    refs.push(manifest.config.compaction.model.source);
  }

  if (manifest.config?.dynamicModel !== undefined) {
    refs.push(toModuleRef(manifest.config.dynamicModel));
  }

  for (const channel of manifest.channelRoutes.effective) {
    refs.push(toModuleRef(channel));
  }

  for (const connection of manifest.connections) {
    refs.push(toModuleRef(connection));
  }

  for (const tool of manifest.tools) {
    refs.push(toModuleRef(tool));
  }

  for (const dynamicInstructions of manifest.dynamicInstructions) {
    refs.push(toModuleRef(dynamicInstructions));
  }

  for (const dynamicSkill of manifest.dynamicSkills) {
    refs.push(toModuleRef(dynamicSkill));
  }

  for (const dynamicTool of manifest.dynamicTools) {
    refs.push(toModuleRef(dynamicTool));
  }

  for (const hook of manifest.hooks) {
    refs.push(toModuleRef(hook));
  }

  if (manifest.instrumentation.kind === "file") {
    refs.push(manifest.instrumentation.entry.source);
  } else if (manifest.instrumentation.kind === "providers") {
    for (const entry of manifest.instrumentation.entries) refs.push(entry.source);
  }

  for (const schedule of manifest.schedules) {
    if (schedule.sourceKind !== "module" || !schedule.hasRun) continue;
    refs.push(toModuleRef(schedule));
  }

  refs.push(toModuleRef(manifest.sandbox));

  for (const mount of manifest.extensionMounts) {
    refs.push({
      logicalPath: mount.mountLogicalPath,
      sourceId: mount.mountSourceId,
      sourceKind: "module",
    });
  }

  return refs;
}

/**
 * Returns one entry per source id after semantic validation has established
 * that repeated references agree on their logical identity.
 */
export function collectUniqueModuleRefsForManifest(
  manifest: CompiledModuleReferenceSource,
): ModuleSourceRef[] {
  const refs = new Map<string, ModuleSourceRef>();

  for (const ref of collectModuleRefsForManifest(manifest)) {
    const existing = refs.get(ref.sourceId);
    if (
      existing !== undefined &&
      (existing.logicalPath !== ref.logicalPath || existing.exportName !== ref.exportName)
    ) {
      throw new Error(
        `Compiled source id "${ref.sourceId}" has conflicting module projections "${renderModuleProjection(existing)}" and "${renderModuleProjection(ref)}".`,
      );
    }
    refs.set(ref.sourceId, ref);
  }

  return [...refs.values()];
}

function renderModuleProjection(ref: ModuleSourceRef): string {
  return `${ref.logicalPath}#${ref.exportName ?? "default"}`;
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
