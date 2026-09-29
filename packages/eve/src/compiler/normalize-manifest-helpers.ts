import { posix } from "node:path";
import type { NodeModuleEvaluationContext } from "#compiler/module-lifecycle.js";
import type { ComposedNodeSourceGraph, SelectedNodeConfig } from "#compiler/node-source-state.js";
import { loadModuleBackedDefinition } from "#compiler/normalize-helpers.js";

import { mountRefNamespace } from "#discover/extensions.js";
import type { AgentSourceManifest, LocalSubagentSourceRef } from "#discover/manifest.js";
import type {
  CompiledAgentDefinition,
  CompiledExtensionMount,
  CompiledRemoteAgentNode,
  CompiledSubagentNode,
} from "#compiler/manifest.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import { normalizeSubagentConfig } from "#compiler/normalize-subagent.js";
import {
  canonicalSourceSlot,
  createAgentModuleBinding,
  extensionMountId,
  isAgentModuleCandidate,
  type AgentModuleCandidate,
  type AgentSourceOwner,
  type AgentSourceRegistry,
  type ComposedAgentModuleCandidates,
  type CompiledModuleBinding,
} from "#compiler/source-graph.js";

export async function loadSelectedNodeConfig(
  state: ComposedNodeSourceGraph,
  evaluation: NodeModuleEvaluationContext,
): Promise<SelectedNodeConfig> {
  const candidate = state.composed.selected.get("agent");
  if (candidate === undefined || !isAgentModuleCandidate(candidate)) {
    throw new Error("Every local agent node requires a selected module-backed agent.ts source.");
  }
  const binding = createAgentModuleBinding(candidate);
  const projected = state.sourcesBySourceId.get(candidate.sourceId);
  if (projected?.source.sourceKind !== "module") {
    throw new Error(`Selected agent config source "${candidate.sourceId}" was not projected.`);
  }
  const source = projected.source;
  return {
    binding,
    candidate,
    definition: await loadModuleBackedDefinition({
      binding,
      kind: "agent config",
      loadNamespace: evaluation.loadNamespace,
      source,
    }),
    source,
  };
}

export function collectSelectedSourceIds(composed: ComposedAgentModuleCandidates): Set<string> {
  return new Set([...composed.selected.values()].map((candidate) => candidate.sourceId));
}

export function assertRootOnlyConfig(
  config: CompiledAgentDefinition,
  isRoot: boolean,
  agentId: string,
): void {
  if (isRoot) return;
  if (config.experimental?.workflow?.world !== undefined) {
    throw new Error(
      `Workflow world configuration is only supported on the root agent config. Remove "experimental.workflow.world" from "${agentId}".`,
    );
  }
}

export function assertApplicationOverlayCanApplyToAllNodes(logicalPaths: readonly string[]): void {
  const unsupported = logicalPaths.find((logicalPath) => {
    const slot = canonicalSourceSlot(logicalPath);
    return (
      slot === "agent" ||
      slot.startsWith("channels/") ||
      slot.startsWith("schedules/") ||
      slot.startsWith("subagents/") ||
      slot.startsWith("extensions/")
    );
  });
  if (unsupported !== undefined) {
    throw new Error(
      `Application programmatic source registered for all local nodes cannot declare "${unsupported}".`,
    );
  }
}

export function assertUniqueRegistryIds(registries: readonly AgentSourceRegistry[]): void {
  const ids = new Set<string>();
  for (const registry of registries) {
    for (const sourceId of registry.sources.keys()) {
      if (ids.has(sourceId)) {
        throw new Error(`Programmatic agent source id "${sourceId}" is registered more than once.`);
      }
      ids.add(sourceId);
    }
  }
}

export function assertNonExtensionSpecialTool(
  candidate: AgentModuleCandidate,
  label: string,
): void {
  if (candidate.owner.kind === "extension") {
    throw new Error(`${label} cannot be configured by an extension source.`);
  }
}

export function withExtensionNamespace<T extends { readonly extensionNamespace?: string }>(
  definition: T,
  owner: AgentSourceOwner,
): T {
  return owner.kind === "extension"
    ? { ...definition, extensionNamespace: owner.namespace }
    : definition;
}

export function assertUniqueBy<T>(
  values: readonly T[],
  identity: (value: T) => string,
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = identity(value);
    if (seen.has(key)) throw new Error(`Compiled ${label} "${key}" is declared more than once.`);
    seen.add(key);
  }
}

export function withDiagnosticsSummary(
  subagents: readonly CompiledSubagentNode[],
  diagnosticsSummary: import("#discover/diagnostics.js").DiscoverDiagnosticsSummary,
): CompiledSubagentNode[] {
  return subagents.map((subagent) =>
    subagent.configResolver === undefined
      ? { ...subagent, agent: { ...subagent.agent, diagnosticsSummary } }
      : { ...subagent, agent: { ...subagent.agent, diagnosticsSummary } },
  );
}

export function expectSubagentDescription(
  config: CompiledAgentDefinition,
  source: LocalSubagentSourceRef,
): string {
  if (config.description === undefined || config.description.trim().length === 0) {
    throw new Error(`Subagent "${source.logicalPath}" must define a non-empty description.`);
  }
  return config.description;
}

export function createCompiledRemoteAgent(input: {
  readonly binding: CompiledModuleBinding;
  readonly definition: Extract<
    ReturnType<typeof normalizeSubagentConfig>,
    { readonly kind: "remote" }
  >;
  readonly nodeId: string;
  readonly owner: AgentSourceOwner;
  readonly parentNodeId: string;
  readonly source: LocalSubagentSourceRef;
  readonly sourceRef: ModuleSourceRef;
}): CompiledRemoteAgentNode {
  const logicalPath =
    input.source.logicalPath.endsWith(".ts") || input.source.logicalPath.endsWith(".js")
      ? input.source.logicalPath
      : posix.join(input.source.logicalPath, "agent.ts");
  const sourceId = input.source.sourceId;
  const binding: CompiledModuleBinding = {
    backing: input.binding.backing,
    logicalPath,
    owner: input.owner,
    usage: input.binding.usage,
  };
  const node = {
    backing: { kind: "resource" as const, sourcePath: input.source.entryPath },
    binding,
    description: input.definition.description,
    entryPath: input.source.entryPath,
    logicalPath,
    name: input.source.subagentId,
    nodeId: input.nodeId,
    owner: input.owner,
    parentNodeId: input.parentNodeId,
    path: input.definition.path,
    rootPath: input.source.rootPath,
    sourceId,
    sourceKind: "module" as const,
  };
  if (input.sourceRef.exportName !== undefined) {
    Object.assign(node, { exportName: input.sourceRef.exportName });
  }
  if (input.definition.tool !== undefined) Object.assign(node, { tool: input.definition.tool });
  if (input.definition.url !== undefined) Object.assign(node, { url: input.definition.url });
  return node;
}

export function compileExtensionMounts(
  manifest: AgentSourceManifest,
  composed: ComposedAgentModuleCandidates,
  nodePath: string,
): CompiledExtensionMount[] {
  const selected = collectSelectedSourceIds(composed);
  return manifest.resolvedExtensions.flatMap((mount) => {
    const mountRef =
      mount.programmaticDeclaration ??
      manifest.extensions.find((entry) => mountRefNamespace(entry.logicalPath) === mount.namespace);
    if (mountRef === undefined || !selected.has(mountRef.sourceId)) return [];
    return [
      {
        externalDependencies: [...mount.externalDependencies],
        mountLogicalPath: mountRef.logicalPath,
        mountSourceId: mountRef.sourceId,
        ...(mount.programmaticDeclaration === undefined
          ? {}
          : {
              programmaticImport: {
                specifier: mount.programmaticDeclaration.importSpecifier,
                entryPath: mount.programmaticDeclaration.entryPath,
                config: mount.programmaticDeclaration.config,
              },
            }),
        mountSourcePath: posix.join(manifest.agentRoot, mountRef.logicalPath),
        namespace: mount.namespace,
        packageName: mount.packageName,
        specifier: mount.specifier,
        mountId: extensionMountId(nodePath, mount.namespace),
            sourceRoot: mount.sourceRoot,
      },
    ];
  });
}

export function mergeExternalDependencies(
  ...lists: ReadonlyArray<readonly string[] | undefined>
): string[] {
  return [...new Set(lists.flatMap((list) => list ?? []))];
}
