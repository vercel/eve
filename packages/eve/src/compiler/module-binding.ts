import { z } from "#compiled/zod/index.js";
import type {
  CompiledAgentManifest,
  CompiledAgentNodeManifest,
  CompiledAgentResources,
} from "#compiler/manifest.js";
import { collectModuleRefsForManifest } from "#compiler/module-references.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { AgentSourceComposition } from "#compiler/source-composition.js";
import { canonicalAgentSourceSlot } from "#compiler/source-slot.js";
import { assertCompiledManifestKernelSemantics } from "#compiler/kernel-plan-semantics.js";
import { assertCompiledAgentExternalDependencyPlan } from "#compiler/external-dependency-plan-semantics.js";
import {
  assertCompiledExtensionProvenance,
  assertCompiledExtensionMountSemantics,
  assertCompiledInstrumentationPlan,
  assertCompiledNodeScopeSemantics,
  assertCompiledRemoteAgentNodeSemantics,
  assertSubagentComposition,
} from "#compiler/compiled-agent-graph-semantics.js";
import { assertCompiledModuleBindingSemantics } from "#compiler/module-binding-semantics.js";
import { assertAgentSourceDescriptorSemantics } from "#compiler/source-composition-semantics.js";
import {
  assertCompiledResourceSemantics,
  assertDynamicSubagentConfigResolverSemantics,
} from "#compiler/compiled-resource-semantics.js";
import { assertCompiledSandboxInheritanceSemantics } from "#compiler/workspace-resource-semantics.js";

export type AgentSourceOwner = z.infer<typeof agentSourceOwnerSchema>;
export type CompiledModuleBacking = z.infer<typeof compiledModuleBackingSchema>;
export type CompiledModuleBinding = z.infer<typeof compiledModuleBindingSchema>;

export const agentSourceOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("application") }).strict(),
  z.object({ feature: z.string(), kind: z.literal("framework") }).strict(),
  z
    .object({
      kind: z.literal("extension"),
      namespace: z.string(),
      packageName: z.string(),
    })
    .strict(),
]);

export const compiledModuleBackingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      externalDependencies: z.array(z.string()).readonly(),
      extensionScope: z
        .object({ namespace: z.string(), sourceRoot: z.string() })
        .strict()
        .optional(),
      kind: z.literal("filesystem"),
      sourcePath: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("programmatic"),
      moduleId: z.string(),
      registryId: z.string(),
      revision: z.string().min(1),
      semanticRevision: z.string().min(1).optional(),
    })
    .strict(),
]);

export const compiledModuleBindingSchema = z
  .object({
    backing: compiledModuleBackingSchema,
    logicalPath: z.string(),
    owner: agentSourceOwnerSchema,
  })
  .strict();

/**
 * Validates the binding contract for a complete compiled artifact graph.
 * Structural schema parsing cannot express cross-record totality, so every
 * construction and load boundary must call this validator.
 */
export function assertCompiledAgentManifestSemantics(manifest: CompiledAgentManifest): void {
  if (manifest.instrumentation === undefined) {
    throw new Error("Compiled root node is missing its instrumentation plan.");
  }
  assertTotalModuleBindings({
    bindings: manifest.bindings,
    manifest,
    nodeId: "__root__",
  });
  assertCompiledInstrumentationPlan(manifest);

  for (const subagent of manifest.subagents) {
    assertCompiledNodeScopeSemantics(subagent.agent, {
      isRoot: false,
      nodeId: subagent.nodeId,
    });
    assertTotalModuleBindings({
      additionalRefs: subagent.configResolver === undefined ? [] : [subagent.configResolver],
      bindings: subagent.agent.bindings,
      manifest: subagent.agent,
      nodeId: subagent.nodeId,
    });
    if (subagent.configResolver !== undefined) {
      assertDynamicSubagentConfigResolverSemantics({
        nodeId: subagent.nodeId,
        resolver: subagent.configResolver,
        resources: subagent.agent,
        subagentLogicalPath: subagent.logicalPath,
      });
    }
  }

  for (const resources of [manifest, ...manifest.subagents.map((subagent) => subagent.agent)]) {
    for (const remoteAgent of resources.remoteAgents) {
      assertCompiledRemoteAgentNodeSemantics(remoteAgent);
    }
  }

  assertSubagentComposition(manifest);
  assertCompiledSandboxInheritanceSemantics(manifest);
  assertCompiledExtensionProvenance(manifest);
  assertCompiledAgentExternalDependencyPlan(manifest);
  assertCompiledManifestKernelSemantics(manifest);
}

export function assertTotalModuleBindings(input: {
  readonly additionalRefs?: readonly ModuleSourceRef[];
  readonly bindings: Readonly<Record<string, CompiledModuleBinding>>;
  readonly manifest: CompiledAgentNodeManifest | CompiledAgentResources;
  readonly nodeId: string;
}): void {
  const refs = new Map<string, ModuleSourceRef>();
  const selectedSourceIds = new Set<string>();
  const selectedModuleSourceIds = new Set<string>();
  const selectedSlots = new Set<string>();
  const winnerSourceIds = new Set<string>();
  const winnerBySlot = new Map<string, string>();

  for (const selected of input.manifest.sourceComposition.selected) {
    if (selected.sourceKind === "non-module") {
      assertAgentSourceDescriptorSemantics({
        descriptor: selected.source,
        nodeId: input.nodeId,
      });
    }
    if (selectedSlots.has(selected.slot)) {
      throw new Error(
        `Compiled node "${input.nodeId}" selects source slot "${selected.slot}" more than once.`,
      );
    }
    selectedSlots.add(selected.slot);
    const sourceId =
      selected.sourceKind === "module" ? selected.sourceId : selected.source.sourceId;
    if (selectedSourceIds.has(sourceId)) {
      throw new Error(
        `Compiled node "${input.nodeId}" selects source id "${sourceId}" more than once.`,
      );
    }
    selectedSourceIds.add(sourceId);
    winnerSourceIds.add(sourceId);
    winnerBySlot.set(selected.slot, sourceId);

    const logicalPath =
      selected.sourceKind === "module"
        ? input.bindings[sourceId]?.logicalPath
        : selected.source.logicalPath;
    if (logicalPath !== undefined && canonicalAgentSourceSlot(logicalPath) !== selected.slot) {
      throw new Error(
        `Compiled node "${input.nodeId}" selects "${sourceId}" for slot "${selected.slot}", but its logical path identifies slot "${canonicalAgentSourceSlot(logicalPath)}".`,
      );
    }

    if (selected.sourceKind === "module") {
      selectedModuleSourceIds.add(sourceId);
      const binding = input.bindings[sourceId];
      if (binding === undefined) {
        throw new Error(`Compiled node "${input.nodeId}" is missing a binding for "${sourceId}".`);
      }
    }
  }

  if ("config" in input.manifest) {
    const configSource = input.manifest.config.source;
    if (canonicalAgentSourceSlot(configSource.logicalPath) !== "agent") {
      throw new Error(
        `Compiled node "${input.nodeId}" config source "${configSource.sourceId}" does not identify the canonical "agent" slot.`,
      );
    }
    const selectedConfigSourceId = winnerBySlot.get("agent");
    if (selectedConfigSourceId !== configSource.sourceId) {
      throw new Error(
        `Compiled node "${input.nodeId}" config source "${configSource.sourceId}" does not match selected agent source "${selectedConfigSourceId ?? "<missing>"}".`,
      );
    }
  }

  for (const disabled of input.manifest.sourceComposition.disabled) {
    assertAgentSourceDescriptorSemantics({
      descriptor: disabled.source,
      nodeId: input.nodeId,
    });
    if (selectedSlots.has(disabled.slot)) {
      throw new Error(
        `Compiled node "${input.nodeId}" both selects and disables source slot "${disabled.slot}".`,
      );
    }
    if (winnerSourceIds.has(disabled.source.sourceId)) {
      throw new Error(
        `Compiled node "${input.nodeId}" uses source id "${disabled.source.sourceId}" for multiple effective sources.`,
      );
    }
    selectedSlots.add(disabled.slot);
    winnerSourceIds.add(disabled.source.sourceId);
    winnerBySlot.set(disabled.slot, disabled.source.sourceId);
    if (canonicalAgentSourceSlot(disabled.source.logicalPath) !== disabled.slot) {
      throw new Error(
        `Compiled node "${input.nodeId}" disables source "${disabled.source.sourceId}" in slot "${disabled.slot}", but its logical path identifies slot "${canonicalAgentSourceSlot(disabled.source.logicalPath)}".`,
      );
    }
    if (input.bindings[disabled.source.sourceId] !== undefined) {
      throw new Error(
        `Compiled node "${input.nodeId}" retains a binding for disabled source "${disabled.source.sourceId}".`,
      );
    }
  }

  const shadowedSourceIds = new Set<string>();
  const shadowedLayersBySlot = new Map<string, Set<string>>();
  for (const shadowed of input.manifest.sourceComposition.shadowed) {
    assertAgentSourceDescriptorSemantics({
      descriptor: shadowed.source,
      nodeId: input.nodeId,
    });
    const slotWinner = winnerBySlot.get(shadowed.slot);
    if (slotWinner === undefined) {
      throw new Error(
        `Compiled node "${input.nodeId}" records shadowed source "${shadowed.source.sourceId}" for unknown slot "${shadowed.slot}".`,
      );
    }
    if (slotWinner !== shadowed.winningSourceId) {
      throw new Error(
        `Compiled node "${input.nodeId}" shadows "${shadowed.source.sourceId}" in slot "${shadowed.slot}" with "${shadowed.winningSourceId}", but that slot is won by "${slotWinner}".`,
      );
    }
    if (shadowed.source.sourceId === shadowed.winningSourceId) {
      throw new Error(
        `Compiled node "${input.nodeId}" records source "${shadowed.source.sourceId}" as shadowing itself.`,
      );
    }
    if (shadowedSourceIds.has(shadowed.source.sourceId)) {
      throw new Error(
        `Compiled node "${input.nodeId}" records shadowed source "${shadowed.source.sourceId}" more than once.`,
      );
    }
    shadowedSourceIds.add(shadowed.source.sourceId);
    const shadowedLayers = shadowedLayersBySlot.get(shadowed.slot) ?? new Set<string>();
    if (shadowedLayers.has(shadowed.source.layer)) {
      throw new Error(
        `Compiled node "${input.nodeId}" records multiple shadowed ${shadowed.source.layer} sources for slot "${shadowed.slot}".`,
      );
    }
    shadowedLayers.add(shadowed.source.layer);
    shadowedLayersBySlot.set(shadowed.slot, shadowedLayers);
    if (winnerSourceIds.has(shadowed.source.sourceId)) {
      throw new Error(
        `Compiled node "${input.nodeId}" records effective source "${shadowed.source.sourceId}" as shadowed.`,
      );
    }
    if (canonicalAgentSourceSlot(shadowed.source.logicalPath) !== shadowed.slot) {
      throw new Error(
        `Compiled node "${input.nodeId}" records shadowed source "${shadowed.source.sourceId}" in slot "${shadowed.slot}", but its logical path identifies slot "${canonicalAgentSourceSlot(shadowed.source.logicalPath)}".`,
      );
    }
    if (input.bindings[shadowed.source.sourceId] !== undefined) {
      throw new Error(
        `Compiled node "${input.nodeId}" retains a binding for shadowed source "${shadowed.source.sourceId}".`,
      );
    }
  }

  for (const ref of [...collectAllModuleRefs(input.manifest), ...(input.additionalRefs ?? [])]) {
    const existing = refs.get(ref.sourceId);
    if (
      existing !== undefined &&
      (existing.logicalPath !== ref.logicalPath || existing.exportName !== ref.exportName)
    ) {
      throw new Error(
        `Compiled node "${input.nodeId}" references source id "${ref.sourceId}" with conflicting module projections "${renderModuleProjection(existing)}" and "${renderModuleProjection(ref)}".`,
      );
    }
    refs.set(ref.sourceId, ref);
  }

  for (const [sourceId, binding] of Object.entries(input.bindings)) {
    assertCompiledModuleBindingSemantics({ binding, nodeId: input.nodeId, sourceId });
  }

  for (const sourceId of selectedModuleSourceIds) {
    if (refs.has(sourceId)) continue;
    throw new Error(
      `Compiled node "${input.nodeId}" selects module source "${sourceId}" without a compiled resource reference.`,
    );
  }

  for (const [sourceId, ref] of refs) {
    if (!selectedSourceIds.has(sourceId)) {
      throw new Error(
        `Compiled node "${input.nodeId}" references module source "${sourceId}" outside its selected source composition.`,
      );
    }
    const binding = input.bindings[sourceId];
    if (binding === undefined) {
      throw new Error(`Compiled node "${input.nodeId}" is missing a binding for "${sourceId}".`);
    }
    if (binding.logicalPath !== ref.logicalPath) {
      throw new Error(
        `Compiled node "${input.nodeId}" binds "${sourceId}" to "${binding.logicalPath}", but its manifest references "${ref.logicalPath}".`,
      );
    }
  }

  for (const sourceId of Object.keys(input.bindings)) {
    if (!selectedSourceIds.has(sourceId)) {
      throw new Error(
        `Compiled node "${input.nodeId}" has an unreferenced binding for "${sourceId}".`,
      );
    }
  }

  assertCompiledExtensionMountSemantics(input.manifest, input.nodeId);
  assertNonModuleComposition(input.manifest.sourceComposition, input.manifest, input.nodeId);
  assertCompiledResourceSemantics(input.manifest, input.nodeId);
}

/** Returns the exact agreed module projection retained for one selected source. */
export function requireAgreedCompiledModuleRef(
  manifest: CompiledAgentNodeManifest | CompiledAgentResources,
  sourceId: string,
): ModuleSourceRef {
  let agreed: ModuleSourceRef | undefined;
  for (const ref of collectAllModuleRefs(manifest)) {
    if (ref.sourceId !== sourceId) continue;
    if (
      agreed !== undefined &&
      (agreed.logicalPath !== ref.logicalPath || agreed.exportName !== ref.exportName)
    ) {
      throw new Error(
        `Compiled source id "${sourceId}" has conflicting module projections "${renderModuleProjection(agreed)}" and "${renderModuleProjection(ref)}".`,
      );
    }
    agreed = ref;
  }
  if (agreed === undefined) {
    throw new Error(`Compiled source id "${sourceId}" has no compiled module projection.`);
  }
  return agreed;
}

function assertNonModuleComposition(
  composition: AgentSourceComposition,
  manifest: CompiledAgentNodeManifest | CompiledAgentResources,
  nodeId: string,
): void {
  const selected = new Map(
    composition.selected
      .filter((entry) => entry.sourceKind === "non-module")
      .map((entry) => [entry.source.sourceId, entry.source] as const),
  );
  const refs = [
    ...manifest.instructions,
    ...manifest.skills,
    ...manifest.schedules,
    ...manifest.sandboxWorkspaces.map((source) => ({
      ...source,
      sourceKind: "workspace" as const,
    })),
  ].filter((source) => source.sourceKind !== "module");
  const refsBySourceId = new Map(refs.map((ref) => [ref.sourceId, ref] as const));

  for (const ref of refs) {
    const source = selected.get(ref.sourceId);
    if (source === undefined) {
      throw new Error(
        `Compiled node "${nodeId}" references non-module source "${ref.sourceId}" outside its selected source composition.`,
      );
    }
    if (source.logicalPath !== ref.logicalPath) {
      throw new Error(
        `Compiled node "${nodeId}" composes non-module source "${ref.sourceId}" at "${source.logicalPath}", but its manifest references "${ref.logicalPath}".`,
      );
    }
    if (source.sourceKind !== ref.sourceKind) {
      throw new Error(
        `Compiled node "${nodeId}" composes non-module source "${ref.sourceId}" as "${source.sourceKind}", but its manifest references "${ref.sourceKind}".`,
      );
    }
  }

  for (const source of selected.values()) {
    if (source.sourceKind === "subagent") continue;
    if (!refsBySourceId.has(source.sourceId)) {
      throw new Error(
        `Compiled node "${nodeId}" selects unreferenced non-module source "${source.sourceId}".`,
      );
    }
  }
}

function collectCompileOnlyModuleRefs(
  manifest: CompiledAgentNodeManifest | CompiledAgentResources,
): ModuleSourceRef[] {
  const refs: ModuleSourceRef[] = [];
  for (const shadowed of manifest.channelRoutes.shadowed) {
    refs.push({
      exportName: shadowed.loser.route.exportName,
      logicalPath: shadowed.loser.route.logicalPath,
      sourceId: shadowed.loser.route.sourceId,
      sourceKind: "module",
    });
  }
  for (const source of [...manifest.instructions, ...manifest.skills, ...manifest.schedules]) {
    if (source.sourceKind !== "module") continue;
    refs.push({
      ...("exportName" in source && source.exportName !== undefined
        ? { exportName: source.exportName }
        : {}),
      logicalPath: source.logicalPath,
      sourceId: source.sourceId,
      sourceKind: "module",
    });
  }
  if (manifest.workflowTool !== undefined) refs.push(manifest.workflowTool);
  if (manifest.webSearchProvider !== undefined) refs.push(manifest.webSearchProvider);
  return refs;
}

function collectAllModuleRefs(
  manifest: CompiledAgentNodeManifest | CompiledAgentResources,
): ModuleSourceRef[] {
  return [...collectModuleRefsForManifest(manifest), ...collectCompileOnlyModuleRefs(manifest)];
}

function renderModuleProjection(ref: ModuleSourceRef): string {
  return `${ref.logicalPath}#${ref.exportName ?? "default"}`;
}
