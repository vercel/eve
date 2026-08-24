import { resolve } from "node:path";

import type {
  AgentSourceManifest,
  ChannelSourceRef,
  ConnectionSourceRef,
  ExtensionSourceRef,
  HookSourceRef,
  InstructionsSourceRef,
  LocalSubagentSourceRef,
  SandboxSourceRef,
  SandboxWorkspaceFolderSourceRef,
  ScheduleSourceRef,
  SkillSourceRef,
  ToolSourceRef,
} from "#discover/manifest.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { CompiledModuleBinding } from "#compiler/module-binding.js";
import type { AgentSourceRegistry } from "#compiler/agent-source-registry.js";
import {
  composeAgentSourceCandidates,
  createAgentSourceComposition,
  createModuleSourceDescriptor,
  type AgentSourceCandidate,
  type AgentSourceComposition,
  type AgentSourceDescriptor,
  type AgentSourceLayer,
  type ComposedAgentSourceEntry,
  canonicalAgentSourceSlot,
} from "#compiler/source-composition.js";
import { createExtensionSourceCandidates } from "#compiler/extension-source-candidates.js";
import {
  loadModuleBackedDefinition,
  normalizeSelectedSource,
  type ManifestCompileContext,
} from "#compiler/normalize-helpers.js";

export type EffectiveAgentSourceKind =
  | "channel"
  | "config"
  | "connection"
  | "extension-mount"
  | "hook"
  | "instrumentation"
  | "instructions"
  | "sandbox"
  | "schedule"
  | "skill"
  | "subagent"
  | "tool"
  | "workspace";

export type EffectiveAgentSourceRef =
  | ChannelSourceRef
  | ConnectionSourceRef
  | ExtensionSourceRef
  | HookSourceRef
  | InstructionsSourceRef
  | SandboxSourceRef
  | ScheduleSourceRef
  | SkillSourceRef
  | ToolSourceRef
  | LocalSubagentSourceRef
  | SandboxWorkspaceFolderSourceRef;

export interface EffectiveAgentSourceCandidate extends AgentSourceCandidate {
  readonly kind: EffectiveAgentSourceKind;
  readonly namespace?: string;
  readonly publicName?: string;
  readonly source: EffectiveAgentSourceRef;
  readonly sourceRoot: string;
  readonly sourcePath?: string;
}

export interface EffectiveAgentNodeSourceGraph {
  readonly bindings: Readonly<Record<string, CompiledModuleBinding>>;
  readonly composition: AgentSourceComposition;
  readonly entries: readonly ComposedAgentSourceEntry<EffectiveAgentSourceCandidate>[];
  readonly manifest: AgentSourceManifest;
  readonly winners: readonly EffectiveAgentSourceCandidate[];
}

export interface AgentNodeSourceOrigin {
  readonly extensionScope?: { readonly namespace: string; readonly sourceRoot: string };
  readonly layer: AgentSourceLayer;
  readonly owner: AgentSourceDescriptor["owner"];
}

export interface PreparedAgentConfigPhase {
  readonly binding: CompiledModuleBinding;
  readonly candidate: EffectiveAgentSourceCandidate;
  readonly definition: unknown;
  readonly graph: EffectiveAgentNodeSourceGraph;
}

export async function prepareAgentConfigPhase(input: {
  readonly externalDependencies: readonly string[];
  readonly isRoot: boolean;
  readonly manifest: AgentSourceManifest;
  readonly nodeId: string;
  readonly origin?: AgentNodeSourceOrigin;
  readonly context: ManifestCompileContext;
}): Promise<PreparedAgentConfigPhase> {
  const graph = composeAgentConfigSources({
    externalDependencies: input.externalDependencies,
    isRoot: input.isRoot,
    manifest: input.manifest,
    nodeId: input.nodeId,
    origin: input.origin,
    registry: input.context.registry,
  });
  const candidate = graph.winners.find((winner) => winner.kind === "config");
  if (candidate === undefined) {
    throw new Error(`Agent node "${input.nodeId}" has no selected agent config source.`);
  }
  if (!isModuleSource(candidate.source)) {
    throw new Error(
      `Agent config source "${candidate.descriptor.sourceId}" must be module-backed.`,
    );
  }
  const source = candidate.source;
  const binding = graph.bindings[candidate.descriptor.sourceId];
  if (binding === undefined) {
    throw new Error(
      `Selected agent config source "${candidate.descriptor.sourceId}" is missing its binding.`,
    );
  }
  const normalizationSource = {
    kind: "agent config",
    logicalPath: candidate.descriptor.logicalPath,
    nodeId: candidate.nodeId,
    sourceId: candidate.descriptor.sourceId,
  };
  const definition = await normalizeSelectedSource(
    binding.backing.kind === "filesystem"
      ? { ...normalizationSource, sourcePath: binding.backing.sourcePath }
      : normalizationSource,
    () =>
      loadModuleBackedDefinition({
        binding,
        kind: "agent config",
        moduleLoader: input.context.moduleLoader,
        source,
      }),
  );
  return { binding, candidate, definition, graph };
}

export function composeAgentConfigSources(input: {
  readonly externalDependencies: readonly string[];
  readonly isRoot: boolean;
  readonly manifest: AgentSourceManifest;
  readonly nodeId: string;
  readonly origin?: AgentNodeSourceOrigin;
  readonly registry?: AgentSourceRegistry;
}): EffectiveAgentNodeSourceGraph {
  const candidates: EffectiveAgentSourceCandidate[] = [];
  if (input.manifest.configModule !== undefined) {
    candidates.push(
      createFilesystemCandidate({
        externalDependencies: input.externalDependencies,
        kind: "config",
        extensionScope: input.origin?.extensionScope,
        layer: input.origin?.layer ?? "application",
        nodeId: input.nodeId,
        owner: input.origin?.owner ?? { kind: "application" },
        source: input.manifest.configModule,
        sourceRoot: input.manifest.agentRoot,
      }),
    );
  }
  // Non-canonical config modules are dynamic subagent resolvers, not candidates
  // for the canonical agent slot that the framework default participates in.
  if (
    input.manifest.configModule === undefined ||
    canonicalAgentSourceSlot(input.manifest.configModule.logicalPath) === "agent"
  ) {
    candidates.push(
      ...createProgrammaticCandidates({
        isRoot: input.isRoot,
        nodeId: input.nodeId,
        registry: input.registry,
      }).filter((candidate) => candidate.kind === "config"),
    );
  }
  return createEffectiveGraph(input.manifest, candidates);
}

export function composeRemainingAgentSources(input: {
  readonly externalDependencies: readonly string[];
  readonly instrumentationProvidersEnabled?: boolean;
  readonly isRoot: boolean;
  readonly manifest: AgentSourceManifest;
  readonly nodeId: string;
  readonly origin?: AgentNodeSourceOrigin;
  readonly registry?: AgentSourceRegistry;
}): EffectiveAgentNodeSourceGraph {
  const owner = input.origin?.owner ?? { kind: "application" as const };
  const candidates: EffectiveAgentSourceCandidate[] = [];
  const addApplication = (
    kind: EffectiveAgentSourceKind,
    sources: readonly EffectiveAgentSourceRef[],
  ): void => {
    for (const source of sources) {
      candidates.push(
        createFilesystemOrValueCandidate({
          externalDependencies: input.externalDependencies,
          kind,
          extensionScope: input.origin?.extensionScope,
          layer: input.origin?.layer ?? "application",
          nodeId: input.nodeId,
          owner,
          source,
          sourceRoot: input.manifest.agentRoot,
        }),
      );
    }
  };

  addApplication("channel", input.manifest.channels);
  addApplication("connection", input.manifest.connections);
  addApplication("extension-mount", input.manifest.extensions);
  addApplication("hook", input.manifest.hooks);
  if (input.instrumentationProvidersEnabled === true) {
    addApplication("instrumentation", input.manifest.instrumentation.providers);
  } else if (input.manifest.instrumentation.file !== undefined) {
    addApplication("instrumentation", [input.manifest.instrumentation.file]);
  }
  addApplication("instructions", input.manifest.instructions);
  if (input.manifest.sandbox !== null) addApplication("sandbox", [input.manifest.sandbox]);
  addApplication("schedule", input.manifest.schedules);
  addApplication("skill", input.manifest.skills);
  addApplication("subagent", input.manifest.subagents);
  addApplication("tool", input.manifest.tools);
  addApplication("workspace", input.manifest.sandboxWorkspaces);

  for (const mount of input.manifest.resolvedExtensions) {
    candidates.push(
      ...createExtensionSourceCandidates({
        createCandidate: createFilesystemOrValueCandidate,
        externalDependencies: input.externalDependencies,
        instrumentationProvidersEnabled: input.instrumentationProvidersEnabled,
        mount,
        nodeId: input.nodeId,
      }),
    );
  }
  candidates.push(
    ...createProgrammaticCandidates({
      isRoot: input.isRoot,
      nodeId: input.nodeId,
      registry: input.registry,
    }).filter(
      (candidate) =>
        candidate.kind !== "config" &&
        (candidate.kind !== "instrumentation" ||
          instrumentationCandidateMatchesMode(
            candidate.descriptor.logicalPath,
            input.instrumentationProvidersEnabled === true,
          )),
    ),
  );

  return createEffectiveGraph(
    input.manifest,
    input.isRoot
      ? candidates
      : candidates.filter((candidate) => !isRootOnlySourceKind(candidate.kind)),
  );
}

export function mergeEffectiveAgentSourceGraphs(
  config: EffectiveAgentNodeSourceGraph,
  remaining: EffectiveAgentNodeSourceGraph,
): EffectiveAgentNodeSourceGraph {
  assertEffectiveGraphIntegrity(config, "config");
  assertEffectiveGraphIntegrity(remaining, "remaining");
  assertDisjointEffectiveGraphs(config, remaining);
  return {
    bindings: Object.freeze({ ...config.bindings, ...remaining.bindings }),
    composition: {
      disabled: Object.freeze([...config.composition.disabled, ...remaining.composition.disabled]),
      selected: Object.freeze([...config.composition.selected, ...remaining.composition.selected]),
      shadowed: Object.freeze([...config.composition.shadowed, ...remaining.composition.shadowed]),
    },
    entries: Object.freeze([...config.entries, ...remaining.entries]),
    manifest: remaining.manifest,
    winners: Object.freeze([...config.winners, ...remaining.winners]),
  };
}

function assertDisjointEffectiveGraphs(
  config: EffectiveAgentNodeSourceGraph,
  remaining: EffectiveAgentNodeSourceGraph,
): void {
  const configSlots = new Set(config.winners.map((winner) => winner.slot));
  const configSourceIds = new Set(
    collectEffectiveGraphDescriptors(config).map((source) => source.sourceId),
  );
  for (const winner of remaining.winners) {
    if (configSlots.has(winner.slot)) {
      throw new Error(
        `Config and remaining source phases both selected slot "${winner.slot}" before normalization.`,
      );
    }
  }
  for (const source of collectEffectiveGraphDescriptors(remaining)) {
    if (configSourceIds.has(source.sourceId)) {
      throw new Error(
        `Config and remaining source phases both contain source id "${source.sourceId}" before normalization.`,
      );
    }
  }
  for (const sourceId of Object.keys(remaining.bindings)) {
    if (config.bindings[sourceId] !== undefined) {
      throw new Error(
        `Config and remaining source phases both produced binding "${sourceId}" before normalization.`,
      );
    }
  }
}

export function finalizeDisabledSources(
  graph: EffectiveAgentNodeSourceGraph,
  disabledSourceIds: ReadonlySet<string>,
): EffectiveAgentNodeSourceGraph {
  if (disabledSourceIds.size === 0) return graph;
  const bindings = { ...graph.bindings };
  for (const sourceId of disabledSourceIds) delete bindings[sourceId];
  return {
    ...graph,
    bindings: Object.freeze(bindings),
    composition: createAgentSourceComposition(graph.entries, disabledSourceIds),
  };
}

function createEffectiveGraph(
  manifest: AgentSourceManifest,
  candidates: readonly EffectiveAgentSourceCandidate[],
): EffectiveAgentNodeSourceGraph {
  const entries = composeAgentSourceCandidates(candidates);
  const winners = entries.map((entry) => entry.winner as EffectiveAgentSourceCandidate);
  const bindings: Record<string, CompiledModuleBinding> = {};
  for (const winner of winners) {
    if (winner.descriptor.sourceKind !== "module") continue;
    const existing = bindings[winner.descriptor.sourceId];
    if (existing !== undefined) {
      throw new Error(
        `Selected source id "${winner.descriptor.sourceId}" identifies both "${existing.logicalPath}" and "${winner.descriptor.logicalPath}".`,
      );
    }
    bindings[winner.descriptor.sourceId] = {
      backing: winner.descriptor.backing,
      logicalPath: winner.descriptor.logicalPath,
      owner: winner.descriptor.owner,
    };
  }
  const graph = {
    bindings: Object.freeze(bindings),
    composition: createAgentSourceComposition(entries),
    entries,
    manifest,
    winners: Object.freeze(winners),
  };
  assertEffectiveGraphIntegrity(graph, "composed");
  return graph;
}

function assertEffectiveGraphIntegrity(graph: EffectiveAgentNodeSourceGraph, phase: string): void {
  const sourceIds = new Set<string>();
  const slots = new Set<string>();
  const entriesBySlot = new Map<string, ComposedAgentSourceEntry<EffectiveAgentSourceCandidate>>();
  const selectedBySlot = new Map(
    graph.composition.selected.map((selected) => [selected.slot, selected] as const),
  );
  const expectedBindings = new Set<string>();

  for (const entry of graph.entries) {
    if (entriesBySlot.has(entry.slot)) {
      throw new Error(`The ${phase} source graph retains slot "${entry.slot}" more than once.`);
    }
    if (
      entry.winner.slot !== entry.slot ||
      !entry.candidates.includes(entry.winner) ||
      entry.candidates.some((candidate) => candidate.slot !== entry.slot)
    ) {
      throw new Error(
        `The ${phase} source graph retained candidates do not match slot "${entry.slot}" and its winner.`,
      );
    }
    entriesBySlot.set(entry.slot, entry);
  }

  for (const winner of graph.winners) {
    const sourceId = winner.descriptor.sourceId;
    if (slots.has(winner.slot)) {
      throw new Error(`The ${phase} source graph selects slot "${winner.slot}" more than once.`);
    }
    slots.add(winner.slot);
    if (sourceIds.has(sourceId)) {
      throw new Error(`The ${phase} source graph contains source id "${sourceId}" more than once.`);
    }
    sourceIds.add(sourceId);
    if (entriesBySlot.get(winner.slot)?.winner !== winner) {
      throw new Error(
        `The ${phase} source graph winner "${sourceId}" does not match its retained composed entry.`,
      );
    }

    const selected = selectedBySlot.get(winner.slot);
    const selectedSourceId =
      selected?.sourceKind === "module" ? selected.sourceId : selected?.source.sourceId;
    if (selectedSourceId !== sourceId) {
      throw new Error(
        `The ${phase} source graph winner "${sourceId}" does not match its selected composition slot "${winner.slot}".`,
      );
    }
    if (
      selected?.sourceKind === "non-module" &&
      JSON.stringify(selected.source) !== JSON.stringify(winner.descriptor)
    ) {
      throw new Error(
        `The ${phase} source graph non-module winner "${sourceId}" does not match its selected source descriptor.`,
      );
    }

    if (winner.descriptor.sourceKind !== "module") continue;
    expectedBindings.add(sourceId);
    const binding = graph.bindings[sourceId];
    if (
      binding === undefined ||
      binding.logicalPath !== winner.descriptor.logicalPath ||
      JSON.stringify(binding.owner) !== JSON.stringify(winner.descriptor.owner) ||
      JSON.stringify(binding.backing) !== JSON.stringify(winner.descriptor.backing)
    ) {
      throw new Error(
        `The ${phase} source graph binding for "${sourceId}" does not match its selected candidate.`,
      );
    }
  }

  for (const shadowed of graph.composition.shadowed) {
    if (sourceIds.has(shadowed.source.sourceId)) {
      throw new Error(
        `The ${phase} source graph contains source id "${shadowed.source.sourceId}" more than once.`,
      );
    }
    sourceIds.add(shadowed.source.sourceId);
  }

  if (selectedBySlot.size !== graph.winners.length || entriesBySlot.size !== graph.winners.length) {
    throw new Error(`The ${phase} source graph composition does not exactly match its winners.`);
  }
  for (const sourceId of Object.keys(graph.bindings)) {
    if (!expectedBindings.has(sourceId)) {
      throw new Error(
        `The ${phase} source graph has an unselected binding for "${sourceId}" before normalization.`,
      );
    }
  }
}

function collectEffectiveGraphDescriptors(
  graph: EffectiveAgentNodeSourceGraph,
): AgentSourceDescriptor[] {
  return graph.entries.flatMap((entry) =>
    entry.candidates.map((candidate) => candidate.descriptor),
  );
}

function createFilesystemOrValueCandidate(input: {
  readonly externalDependencies: readonly string[];
  readonly kind: EffectiveAgentSourceKind;
  readonly layer: AgentSourceLayer;
  readonly namespace?: string;
  readonly nodeId: string;
  readonly owner: AgentSourceDescriptor["owner"];
  readonly publicName?: string;
  readonly source: EffectiveAgentSourceRef;
  readonly sourceRoot: string;
  readonly sourcePath?: string;
  readonly extensionScope?: { readonly namespace: string; readonly sourceRoot: string };
}): EffectiveAgentSourceCandidate {
  if ("sourceKind" in input.source && input.source.sourceKind === "module") {
    return createFilesystemCandidate({ ...input, source: input.source });
  }
  let descriptor: AgentSourceDescriptor;
  if (isSubagent(input.source)) {
    descriptor = {
      backing: createStructuralBacking(input, input.source.entryPath),
      layer: input.layer,
      logicalPath: input.source.logicalPath,
      owner: input.owner,
      sourceId: input.source.sourceId,
      sourceKind: "subagent",
    };
  } else {
    descriptor = {
      layer: input.layer,
      logicalPath: input.source.logicalPath,
      owner: input.owner,
      sourceId: input.source.sourceId,
      sourceKind: isWorkspace(input.source) ? "workspace" : input.source.sourceKind,
    };
  }
  const metadata: { namespace?: string; publicName?: string } = {};
  const publicName =
    input.publicName ?? (isSubagent(input.source) ? input.source.subagentId : undefined);
  if (input.namespace !== undefined) metadata.namespace = input.namespace;
  if (publicName !== undefined) metadata.publicName = publicName;
  return {
    descriptor,
    kind: input.kind,
    ...metadata,
    nodeId: input.nodeId,
    slot: slotFor(input.kind, input.source.logicalPath, publicName),
    source: input.source,
    sourceRoot: input.sourceRoot,
    sourcePath: input.sourcePath,
  };
}

function createStructuralBacking(
  input: {
    readonly externalDependencies: readonly string[];
    readonly extensionScope?: { readonly namespace: string; readonly sourceRoot: string };
    readonly sourceRoot: string;
  },
  sourcePath: string,
): Extract<CompiledModuleBinding["backing"], { kind: "filesystem" }> {
  const backing: Extract<CompiledModuleBinding["backing"], { kind: "filesystem" }> = {
    externalDependencies: [...input.externalDependencies],
    kind: "filesystem",
    sourcePath: resolve(input.sourceRoot, sourcePath),
  };
  if (input.extensionScope !== undefined) backing.extensionScope = input.extensionScope;
  return backing;
}

function createFilesystemCandidate(input: {
  readonly externalDependencies: readonly string[];
  readonly extensionScope?: { readonly namespace: string; readonly sourceRoot: string };
  readonly kind: EffectiveAgentSourceKind;
  readonly layer: AgentSourceLayer;
  readonly namespace?: string;
  readonly nodeId: string;
  readonly owner: AgentSourceDescriptor["owner"];
  readonly publicName?: string;
  readonly source: ModuleSourceRef;
  readonly sourceRoot: string;
  readonly sourcePath?: string;
}): EffectiveAgentSourceCandidate {
  const backing: Extract<CompiledModuleBinding["backing"], { kind: "filesystem" }> = {
    externalDependencies: [...input.externalDependencies],
    kind: "filesystem" as const,
    sourcePath: input.sourcePath ?? resolve(input.sourceRoot, input.source.logicalPath),
  };
  if (input.extensionScope !== undefined) backing.extensionScope = input.extensionScope;
  const metadata: { namespace?: string; publicName?: string } = {};
  if (input.namespace !== undefined) metadata.namespace = input.namespace;
  if (input.publicName !== undefined) metadata.publicName = input.publicName;
  return {
    descriptor: createModuleSourceDescriptor({
      backing,
      exportName: input.source.exportName,
      layer: input.layer,
      logicalPath: input.source.logicalPath,
      owner: input.owner,
      sourceId: input.source.sourceId,
    }),
    kind: input.kind,
    ...metadata,
    nodeId: input.nodeId,
    slot: slotFor(input.kind, input.source.logicalPath, input.publicName),
    source: input.source,
    sourceRoot: input.sourceRoot,
  };
}

function createProgrammaticCandidates(input: {
  readonly isRoot: boolean;
  readonly nodeId: string;
  readonly registry?: AgentSourceRegistry;
}): EffectiveAgentSourceCandidate[] {
  if (input.registry === undefined) return [];
  return input.registry.registrations.flatMap((registration) => {
    if (registration.applyTo === "root" && !input.isRoot) return [];
    return registration.source.modules.map((module) => {
      const kind = inferKind(module.logicalPath);
      const source: {
        exportName?: string;
        logicalPath: string;
        sourceId: string;
        sourceKind: "module";
      } = {
        logicalPath: module.logicalPath,
        sourceId: `${registration.source.id}:${module.logicalPath}`,
        sourceKind: "module",
      };
      if (module.exportName !== undefined) source.exportName = module.exportName;
      const descriptor = createModuleSourceDescriptor({
        backing: {
          kind: "programmatic",
          moduleId: module.logicalPath,
          registryId: registration.source.id,
          revision: registration.source.revision,
          ...(module.semanticRevision === undefined
            ? {}
            : { semanticRevision: module.semanticRevision }),
        },
        exportName: module.exportName,
        layer: registration.layer,
        logicalPath: module.logicalPath,
        owner: registration.owner,
        sourceId: source.sourceId,
      });
      return {
        descriptor,
        kind,
        nodeId: input.nodeId,
        slot: slotFor(kind, module.logicalPath),
        source,
        sourceRoot: "",
      };
    });
  });
}

function slotFor(kind: EffectiveAgentSourceKind, logicalPath: string, publicName?: string): string {
  if (kind === "subagent") return `subagents/${publicName ?? logicalPath}`;
  if (kind === "workspace") return logicalPath;
  return canonicalAgentSourceSlot(logicalPath);
}

function inferKind(logicalPath: string): EffectiveAgentSourceKind {
  const root = logicalPath.split("/", 1)[0]!;
  if (root.startsWith("agent.")) return "config";
  if (root === "sandbox" || logicalPath.startsWith("sandbox.")) return "sandbox";
  if (root === "channels") return "channel";
  if (root === "connections") return "connection";
  if (root === "extensions") return "extension-mount";
  if (root === "hooks") return "hook";
  if (root === "instrumentation" || logicalPath.startsWith("instrumentation.")) {
    return "instrumentation";
  }
  if (root === "instructions" || logicalPath.startsWith("instructions.")) return "instructions";
  if (root === "schedules") return "schedule";
  if (root === "skills") return "skill";
  if (root === "subagents") return "subagent";
  if (root === "tools") return "tool";
  throw new Error(`Unsupported agent source slot "${logicalPath}".`);
}

function instrumentationCandidateMatchesMode(
  logicalPath: string,
  providersEnabled: boolean,
): boolean {
  return providersEnabled
    ? logicalPath.startsWith("instrumentation/")
    : logicalPath.startsWith("instrumentation.");
}

function isRootOnlySourceKind(kind: EffectiveAgentSourceKind): boolean {
  return kind === "channel" || kind === "instrumentation" || kind === "schedule";
}

function isSubagent(source: EffectiveAgentSourceRef): source is LocalSubagentSourceRef {
  return "manifest" in source && "subagentId" in source;
}

function isWorkspace(source: EffectiveAgentSourceRef): source is SandboxWorkspaceFolderSourceRef {
  return "rootEntries" in source && "sourcePath" in source;
}

export function isEffectiveModuleSource(
  source: EffectiveAgentSourceRef,
): source is ModuleSourceRef {
  return isModuleSource(source);
}

function isModuleSource(source: EffectiveAgentSourceRef): source is ModuleSourceRef {
  return "sourceKind" in source && source.sourceKind === "module";
}
