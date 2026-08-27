import { posix } from "node:path";

import { mountRefNamespace, packageStateNamespace } from "#discover/extensions.js";
import type { AgentSourceManifest, LocalSubagentSourceRef } from "#discover/manifest.js";
import type {
  CompiledAgentDefinition,
  CompiledExtensionMount,
  CompiledRemoteAgentNode,
} from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import { normalizeSubagentConfig } from "#compiler/normalize-subagent.js";
import {
  canonicalSourceSlot,
  type AgentModuleCandidate,
  type AgentSourceOwner,
  type AgentSourceRegistry,
  type ComposedAgentModuleCandidates,
  type CompiledModuleBinding,
} from "#compiler/source-graph.js";

export function collectSelectedSourceIds(composed: ComposedAgentModuleCandidates): Set<string> {
  return new Set([...composed.selected.values()].map((candidate) => candidate.sourceId));
}

export function assertRootOnlyConfig(
  config: CompiledAgentDefinition,
  isRoot: boolean,
  agentId: string,
): void {
  if (isRoot) return;
  if (config.experimental?.workflow !== undefined) {
    throw new Error(
      `Workflow runtime configuration is only supported on the root agent config. Remove "experimental.workflow" from "${agentId}".`,
    );
  }
  if (config.experimental?.tasks !== undefined) {
    throw new Error(
      `Background tasks are only supported on the root agent config. Remove "experimental.tasks" from "${agentId}".`,
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

export function assertRootOwnedSpecialTool(candidate: AgentModuleCandidate, label: string): void {
  if (candidate.nodeId !== ROOT_COMPILED_AGENT_NODE_ID) {
    throw new Error(`${label} can only be enabled on the root agent.`);
  }
  assertNonExtensionSpecialTool(candidate, label);
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
  if (input.definition.outputSchema !== undefined) {
    Object.assign(node, { outputSchema: input.definition.outputSchema });
  }
  if (input.definition.url !== undefined) Object.assign(node, { url: input.definition.url });
  return node;
}

export function compileExtensionMounts(
  manifest: AgentSourceManifest,
  composed: ComposedAgentModuleCandidates,
): CompiledExtensionMount[] {
  const selected = collectSelectedSourceIds(composed);
  return manifest.resolvedExtensions.flatMap((mount) => {
    const mountRef = manifest.extensions.find(
      (entry) => mountRefNamespace(entry.logicalPath) === mount.namespace,
    );
    if (mountRef === undefined || !selected.has(mountRef.sourceId)) return [];
    return [
      {
        externalDependencies: [...mount.externalDependencies],
        mountLogicalPath: mountRef.logicalPath,
        mountSourceId: mountRef.sourceId,
        namespace: mount.namespace,
        packageName: mount.packageName,
        packageNamespace: packageStateNamespace(mount.packageName),
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
