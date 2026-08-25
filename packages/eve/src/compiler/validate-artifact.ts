import type {
  CompiledAgentManifest,
  CompiledAgentNodeManifest,
  CompiledAgentResources,
  CompiledChannelDefinition,
  CompiledSubagentNode,
} from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleBinding } from "#compiler/source-graph.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { collectModuleBindingsForManifest } from "#compiler/module-map.js";
import { HOST_HTTP_INVENTORY } from "#framework/host-inventory.js";

type CompiledNode = CompiledAgentNodeManifest | CompiledAgentResources;

/** Validates invariants that cannot be expressed by the serialized Zod shape. */
export function validateCompiledAgentManifest(manifest: CompiledAgentManifest): void {
  const nodes = new Map<string, CompiledNode>([[ROOT_COMPILED_AGENT_NODE_ID, manifest]]);
  for (const subagent of manifest.subagents) {
    if (nodes.has(subagent.nodeId)) {
      fail(`subagent node id "${subagent.nodeId}" is duplicated`);
    }
    nodes.set(subagent.nodeId, subagent.agent);
    validateSubagentRecord(subagent);
  }
  validateSubagentTree(manifest, nodes);

  validateCompiledAgentResources(manifest, {
    activeResourceSourceIds: manifest.subagents
      .filter((node) => node.parentNodeId === ROOT_COMPILED_AGENT_NODE_ID)
      .map((node) => node.sourceId),
  });
  for (const subagent of manifest.subagents) {
    validateCompiledAgentResources(subagent.agent, {
      additionalModuleSources:
        subagent.configResolver === undefined ? [] : [subagent.configResolver],
      activeResourceSourceIds: manifest.subagents
        .filter((node) => node.parentNodeId === subagent.nodeId)
        .map((node) => node.sourceId),
    });
  }

  for (const [nodeId, node] of nodes) {
    validateUniqueIdentities(
      [
        ...node.tools.map((tool) => ({ identity: tool.name, kind: "tool" })),
        ...node.remoteAgents.map((agent) => ({ identity: agent.name, kind: "remote agent" })),
        ...manifest.subagents
          .filter((agent) => agent.parentNodeId === nodeId)
          .map((agent) => ({ identity: agent.name, kind: "local agent" })),
      ],
      "tool and subagent public name",
    );
  }
}

function validateSubagentTree(
  manifest: CompiledAgentManifest,
  nodes: ReadonlyMap<string, CompiledNode>,
): void {
  const parentByNodeId = new Map(
    manifest.subagents.map((subagent) => [subagent.nodeId, subagent.parentNodeId]),
  );
  for (const subagent of manifest.subagents) {
    if (!nodes.has(subagent.parentNodeId)) {
      fail(`subagent node "${subagent.nodeId}" has missing parent "${subagent.parentNodeId}"`);
    }
    const lineage = new Set<string>();
    let nodeId = subagent.nodeId;
    while (nodeId !== ROOT_COMPILED_AGENT_NODE_ID) {
      if (lineage.has(nodeId)) {
        fail(`subagent graph contains a cycle at node "${nodeId}"`);
      }
      lineage.add(nodeId);
      const parentNodeId = parentByNodeId.get(nodeId);
      if (parentNodeId === undefined) {
        fail(`subagent node "${subagent.nodeId}" is not reachable from the root`);
      }
      nodeId = parentNodeId;
    }
  }
}

/** Validates exact module-map parity with the manifest's required binding tables. */
export function validateCompiledModuleMap(
  manifest: CompiledAgentManifest,
  moduleMap: CompiledModuleMap,
): void {
  const expected = new Map<string, Set<string>>([
    [
      "__root__",
      new Set(collectModuleBindingsForManifest(manifest).map((binding) => binding.sourceId)),
    ],
    ...manifest.subagents.map(
      (subagent) =>
        [
          subagent.nodeId,
          new Set(
            collectModuleBindingsForManifest(subagent.agent).map((binding) => binding.sourceId),
          ),
        ] as const,
    ),
  ]);
  const actualNodeIds = Object.keys(moduleMap.nodes);
  if (
    actualNodeIds.length !== expected.size ||
    actualNodeIds.some((nodeId) => !expected.has(nodeId))
  ) {
    fail("compiled module map node set does not match the manifest");
  }
  for (const [nodeId, sourceIds] of expected) {
    const actual = moduleMap.nodes[nodeId];
    if (actual === undefined) fail(`compiled module map node "${nodeId}" is missing`);
    const actualSourceIds = Object.keys(actual.modules);
    if (
      actualSourceIds.length !== sourceIds.size ||
      actualSourceIds.some((sourceId) => !sourceIds.has(sourceId))
    ) {
      fail(`compiled module map sources for node "${nodeId}" do not match its bindings`);
    }
  }
}

/** Validates one node's bindings, composition, and route-plan integrity. */
export function validateCompiledAgentResources(
  node: CompiledNode,
  options: {
    readonly additionalModuleSources?: readonly {
      readonly logicalPath: string;
      readonly sourceId: string;
    }[];
    readonly activeResourceSourceIds?: readonly string[];
    readonly allowUnknownResourceWinners?: boolean;
  } = {},
): void {
  validateUniqueIdentities(
    node.tools.map((entry) => ({ identity: entry.name, kind: "tool" })),
    "tool name",
  );
  validateUniqueIdentities(
    node.dynamicTools.map((entry) => ({ identity: entry.slug, kind: "dynamic tool" })),
    "dynamic tool slug",
  );
  validateUniqueIdentities(
    node.skills.map((entry) => ({ identity: entry.name, kind: "skill" })),
    "skill name",
  );
  validateUniqueIdentities(
    node.dynamicSkills.map((entry) => ({ identity: entry.slug, kind: "dynamic skill" })),
    "dynamic skill slug",
  );
  validateUniqueIdentities(
    node.instructions.map((entry) => ({ identity: entry.name, kind: "instructions" })),
    "instructions name",
  );
  validateUniqueIdentities(
    node.dynamicInstructions.map((entry) => ({
      identity: entry.slug,
      kind: "dynamic instructions",
    })),
    "dynamic instructions slug",
  );
  validateUniqueIdentities(
    node.connections.map((entry) => ({ identity: entry.connectionName, kind: "connection" })),
    "connection name",
  );
  validateUniqueIdentities(
    node.hooks.map((entry) => ({ identity: entry.slug, kind: "hook" })),
    "hook slug",
  );
  validateUniqueIdentities(
    node.memories.map((entry) => ({ identity: entry.slot, kind: "memory" })),
    "memory slot",
  );
  validateUniqueIdentities(
    node.schedules.map((entry) => ({ identity: entry.name, kind: "schedule" })),
    "schedule name",
  );
  const referencedModuleSources = collectReferencedModuleSources(node);
  for (const source of options.additionalModuleSources ?? []) {
    referencedModuleSources.set(source.sourceId, { logicalPath: source.logicalPath });
  }
  for (const [sourceId, reference] of referencedModuleSources) {
    const binding = node.bindings[sourceId];
    if (binding === undefined) fail(`module source "${sourceId}" has no compiled binding`);
    validateBinding(sourceId, reference.logicalPath, binding);
  }
  for (const sourceId of Object.keys(node.bindings)) {
    if (!referencedModuleSources.has(sourceId)) {
      fail(`compiled binding "${sourceId}" is not referenced by its node manifest`);
    }
  }
  validateProgrammaticBindingDependencies(node.bindings);

  const activeSourceIds = new Set([
    ...referencedModuleSources.keys(),
    ...collectActiveResourceSourceIds(node),
    ...node.remoteAgents.map((remote) => remote.sourceId),
    ...(options.activeResourceSourceIds ?? []),
  ]);
  const disabledSourceIds = new Set<string>();
  for (const entry of node.sourceComposition.entries) {
    if (entry.kind === "disabled") {
      if (disabledSourceIds.has(entry.source.sourceId)) {
        fail(`disabled composition source "${entry.source.sourceId}" is duplicated`);
      }
      disabledSourceIds.add(entry.source.sourceId);
      if (node.bindings[entry.source.sourceId] !== undefined) {
        fail(`disabled source "${entry.source.sourceId}" retains an active binding`);
      }
      continue;
    }
    if (
      !activeSourceIds.has(entry.winnerSourceId) &&
      !disabledSourceIds.has(entry.winnerSourceId) &&
      !node.sourceComposition.entries.some(
        (candidate) =>
          candidate.kind === "disabled" && candidate.source.sourceId === entry.winnerSourceId,
      ) &&
      options.allowUnknownResourceWinners !== true
    ) {
      fail(
        `shadowed source "${entry.source.sourceId}" has dangling winner "${entry.winnerSourceId}"`,
      );
    }
  }
  validateChannelRoutePlan(node);
  for (const remote of node.remoteAgents) {
    validateBinding(remote.sourceId, remote.logicalPath, remote.binding);
    if (remote.parentNodeId.length === 0) fail(`remote agent "${remote.sourceId}" has no parent`);
  }
}

function validateSubagentRecord(subagent: CompiledSubagentNode): void {
  if (subagent.backing.kind !== "resource" || subagent.backing.sourcePath.length === 0) {
    fail(`subagent "${subagent.nodeId}" has no physical resource backing`);
  }
  if (subagent.parentNodeId.length === 0) fail(`subagent "${subagent.nodeId}" has no parent`);
  if (subagent.configResolver !== undefined) {
    const binding = subagent.agent.bindings[subagent.configResolver.sourceId];
    if (binding === undefined) {
      fail(`dynamic subagent "${subagent.nodeId}" config resolver has no binding`);
    }
    validateBinding(subagent.configResolver.sourceId, subagent.configResolver.logicalPath, binding);
  }
}

function validateBinding(
  sourceId: string,
  logicalPath: string,
  binding: CompiledModuleBinding,
): void {
  if (binding.logicalPath !== logicalPath) {
    fail(`compiled binding "${sourceId}" targets "${binding.logicalPath}", not "${logicalPath}"`);
  }
  if (
    binding.owner.kind === "extension" &&
    binding.backing.kind === "filesystem" &&
    binding.backing.extensionScope === undefined
  ) {
    fail(`extension-owned filesystem binding "${sourceId}" has no extension scope`);
  }
}

function validateProgrammaticBindingDependencies(
  bindings: Readonly<Record<string, CompiledModuleBinding>>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (sourceId: string): void => {
    if (visited.has(sourceId)) return;
    if (visiting.has(sourceId)) {
      fail(`programmatic binding dependency cycle includes "${sourceId}"`);
    }
    const binding = bindings[sourceId];
    if (binding === undefined) fail(`programmatic binding dependency "${sourceId}" is missing`);
    visiting.add(sourceId);
    if (binding.backing.kind === "programmatic") {
      for (const [alias, dependencySourceId] of Object.entries(
        binding.backing.dependencies ?? {},
      )) {
        if (alias.trim().length === 0) {
          fail(`programmatic binding "${sourceId}" has an empty dependency alias`);
        }
        if (bindings[dependencySourceId] === undefined) {
          fail(
            `programmatic binding "${sourceId}" depends on missing binding "${dependencySourceId}"`,
          );
        }
        visit(dependencySourceId);
      }
    }
    visiting.delete(sourceId);
    visited.add(sourceId);
  };
  for (const sourceId of Object.keys(bindings)) visit(sourceId);
}

function collectReferencedModuleSources(
  node: CompiledNode,
): Map<string, { readonly logicalPath: string }> {
  const sources = new Map<string, { readonly logicalPath: string }>();
  const add = (source: { readonly sourceId: string; readonly logicalPath: string }) => {
    const existing = sources.get(source.sourceId);
    if (existing !== undefined && existing.logicalPath !== source.logicalPath) {
      fail(`module source "${source.sourceId}" is referenced with two logical paths`);
    }
    sources.set(source.sourceId, { logicalPath: source.logicalPath });
  };
  if ("config" in node) {
    add(node.config.source);
    if (node.config.model?.source !== undefined) add(node.config.model.source);
    if (node.config.dynamicModel !== undefined) add(node.config.dynamicModel);
  }
  for (const route of node.channelRoutes.effective) add(route);
  for (const route of node.channelRoutes.shadowed) {
    if (route.source.backing.kind !== "resource") add(route.source);
  }
  for (const value of node.connections) add(value);
  for (const value of node.tools) add(value);
  for (const value of node.dynamicInstructions) add(value);
  for (const value of node.dynamicSkills) add(value);
  for (const value of node.dynamicTools) add(value);
  for (const value of node.hooks) add(value);
  for (const value of node.memories) add(value);
  for (const value of node.instructions) if (value.sourceKind === "module") add(value);
  if (node.instrumentation !== undefined) add(node.instrumentation);
  if (node.workflowTool !== undefined) add(node.workflowTool);
  for (const value of node.skills) if (value.sourceKind === "module") add(value);
  for (const value of node.schedules) if (value.sourceKind === "module") add(value);
  add(node.sandbox);
  for (const mount of node.extensionMounts) {
    add({ logicalPath: mount.mountLogicalPath, sourceId: mount.mountSourceId });
  }
  return sources;
}

function collectActiveResourceSourceIds(node: CompiledNode): string[] {
  return [
    ...node.instructions
      .filter((value) => value.sourceKind !== "module")
      .map((value) => value.sourceId),
    ...node.skills.filter((value) => value.sourceKind !== "module").map((value) => value.sourceId),
    ...node.schedules
      .filter((value) => value.sourceKind !== "module")
      .map((value) => value.sourceId),
    ...node.sandboxWorkspaces.map((value) => value.sourceId),
  ];
}

function validateChannelRoutePlan(node: CompiledNode): void {
  const effectiveKeys = new Set<string>();
  const effectiveSourceIds = new Set<string>();
  for (const route of node.channelRoutes.effective) {
    const key = routeIdentity(route);
    if (effectiveKeys.has(key)) fail(`effective channel route "${key}" is duplicated`);
    effectiveKeys.add(key);
    effectiveSourceIds.add(route.sourceId);
    if (node.bindings[route.sourceId] === undefined) {
      fail(`effective channel route source "${route.sourceId}" has no binding`);
    }
    const reserved = HOST_HTTP_INVENTORY.find(
      (host) =>
        methodsOverlap(route.method, host.method) && patternsOverlap(route.urlPath, host.path),
    );
    if (reserved !== undefined) {
      fail(`effective route ${route.method} ${route.urlPath} overlaps reserved host route`);
    }
  }
  for (const route of node.channelRoutes.shadowed) {
    if (!effectiveSourceIds.has(route.winnerSourceId)) {
      fail(`shadowed channel route has dangling winner "${route.winnerSourceId}"`);
    }
  }
  const preflightKeys = new Set<string>();
  for (const preflight of node.channelRoutes.preflight) {
    const key = normalizePattern(preflight.urlPath);
    if (preflightKeys.has(key)) fail(`generated preflight "${key}" is duplicated`);
    preflightKeys.add(key);
    if (preflight.sourceIds.length === 0) fail(`generated preflight "${key}" has no causes`);
    for (const sourceId of preflight.sourceIds) {
      const cause = node.channelRoutes.effective.find(
        (route) =>
          route.sourceId === sourceId &&
          route.cors !== undefined &&
          route.method !== "WEBSOCKET" &&
          patternsOverlap(route.urlPath, preflight.urlPath),
      );
      if (cause === undefined) fail(`generated preflight "${key}" has invalid cause "${sourceId}"`);
    }
  }
}

function routeIdentity(route: CompiledChannelDefinition): string {
  return `${route.method} ${normalizePattern(route.urlPath)}`;
}

function normalizePattern(path: string): string {
  return splitPath(path)
    .map((segment) => (isParameter(segment) ? ":" : segment))
    .join("/");
}

function patternsOverlap(left: string, right: string): boolean {
  const leftParts = splitPath(left);
  const rightParts = splitPath(right);
  return (
    leftParts.length === rightParts.length &&
    leftParts.every(
      (part, index) =>
        part === rightParts[index] || isParameter(part) || isParameter(rightParts[index]!),
    )
  );
}

function splitPath(path: string): string[] {
  return path.replace(/^\/+|\/+$/g, "").split("/");
}

function isParameter(segment: string): boolean {
  return segment.startsWith(":") || /^\[[^\]]+\]$/.test(segment);
}

function methodsOverlap(left: string, right: string): boolean {
  return left === "ALL" || right === "ALL" || left === right;
}

function validateUniqueIdentities(
  entries: readonly { readonly identity: string; readonly kind: string }[],
  label: string,
): void {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const existing = seen.get(entry.identity);
    if (existing !== undefined) {
      fail(`${label} "${entry.identity}" is shared by ${existing} and ${entry.kind}`);
    }
    seen.set(entry.identity, entry.kind);
  }
}

function fail(message: string): never {
  throw new Error(`Invalid compiled eve artifact: ${message}.`);
}
