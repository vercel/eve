import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  createCompiledSubagentNodeId,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/compiled-agent-node-id.js";
import type {
  CompiledAgentManifest,
  CompiledAgentNodeManifest,
  CompiledAgentResources,
} from "#compiler/manifest.js";
import type {
  AgentSourceOwner,
  CompiledModuleBacking,
  CompiledModuleBinding,
} from "#compiler/module-binding.js";
import { assertCompiledModuleBindingSemantics } from "#compiler/module-binding-semantics.js";
import type { AgentSourceComposition } from "#compiler/source-composition.js";
import { assertAgentSourceDescriptorSemantics } from "#compiler/source-composition-semantics.js";
import { canonicalAgentSourceSlot } from "#compiler/source-slot.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

export {
  assertCompiledExtensionMountSemantics,
  assertCompiledExtensionProvenance,
} from "#compiler/compiled-extension-semantics.js";

export function assertCompiledRemoteAgentNodeSemantics(
  node: CompiledAgentManifest["remoteAgents"][number],
): void {
  if (node.url !== undefined && node.url.length === 0) {
    throw new Error(`Compiled remote agent "${node.nodeId}" has an empty static url.`);
  }
  if (node.sourceComposition.disabled.length !== 0) {
    throw new Error(`Compiled remote agent "${node.nodeId}" cannot disable its config source.`);
  }
  if (node.sourceComposition.selected.length !== 1) {
    throw new Error(
      `Compiled remote agent "${node.nodeId}" must retain exactly one selected config source.`,
    );
  }
  const selected = node.sourceComposition.selected[0]!;
  if (
    selected.sourceKind !== "module" ||
    selected.sourceId !== node.configResolver.sourceId ||
    selected.slot !== canonicalAgentSourceSlot(node.configResolver.logicalPath)
  ) {
    throw new Error(
      `Compiled remote agent "${node.nodeId}" config resolver does not match its selected source.`,
    );
  }
  const bindingIds = Object.keys(node.bindings);
  const binding = node.bindings[node.configResolver.sourceId];
  if (
    bindingIds.length !== 1 ||
    binding === undefined ||
    binding.logicalPath !== node.configResolver.logicalPath
  ) {
    throw new Error(
      `Compiled remote agent "${node.nodeId}" must retain exactly its selected config binding.`,
    );
  }
  assertCompiledModuleBindingSemantics({
    binding,
    nodeId: node.nodeId,
    sourceId: node.configResolver.sourceId,
  });
  if (!sameOwner(binding.owner, node.owner)) {
    throw new Error(
      `Compiled remote agent "${node.nodeId}" config binding does not preserve its source owner.`,
    );
  }
  if (!sameModuleBacking(binding.backing, node.backing)) {
    throw new Error(
      `Compiled remote agent "${node.nodeId}" config binding does not preserve its source backing.`,
    );
  }

  const shadowedSourceIds = new Set<string>();
  const shadowedLayers = new Set<string>();
  for (const shadowed of node.sourceComposition.shadowed) {
    assertAgentSourceDescriptorSemantics({
      descriptor: shadowed.source,
      nodeId: node.nodeId,
    });
    if (
      shadowed.slot !== selected.slot ||
      shadowed.winningSourceId !== selected.sourceId ||
      shadowed.source.sourceId === selected.sourceId ||
      canonicalAgentSourceSlot(shadowed.source.logicalPath) !== shadowed.slot
    ) {
      throw new Error(
        `Compiled remote agent "${node.nodeId}" has an invalid shadowed config source.`,
      );
    }
    if (shadowedSourceIds.has(shadowed.source.sourceId)) {
      throw new Error(
        `Compiled remote agent "${node.nodeId}" repeats shadowed source "${shadowed.source.sourceId}".`,
      );
    }
    shadowedSourceIds.add(shadowed.source.sourceId);
    if (shadowedLayers.has(shadowed.source.layer)) {
      throw new Error(
        `Compiled remote agent "${node.nodeId}" repeats shadowed layer "${shadowed.source.layer}".`,
      );
    }
    shadowedLayers.add(shadowed.source.layer);
    if (node.bindings[shadowed.source.sourceId] !== undefined) {
      throw new Error(
        `Compiled remote agent "${node.nodeId}" retains a binding for shadowed source "${shadowed.source.sourceId}".`,
      );
    }
  }
}

/** Rejects host-owned source and configuration state on local child nodes. */
export function assertCompiledNodeScopeSemantics(
  resources: CompiledAgentNodeManifest | CompiledAgentResources,
  context: { readonly isRoot: boolean; readonly nodeId: string },
): void {
  if (context.isRoot) return;

  for (const entry of [
    ...resources.sourceComposition.selected,
    ...resources.sourceComposition.disabled,
    ...resources.sourceComposition.shadowed,
  ]) {
    if (!isRootOnlySourceSlot(entry.slot)) continue;
    throw new Error(
      `Compiled child node "${context.nodeId}" retains root-only source slot "${entry.slot}".`,
    );
  }

  if (
    resources.channelRoutes.effective.length !== 0 ||
    resources.channelRoutes.preflight.length !== 0 ||
    resources.channelRoutes.shadowed.length !== 0
  ) {
    throw new Error(`Compiled child node "${context.nodeId}" retains root-only channel routes.`);
  }
  if (resources.schedules.length !== 0) {
    throw new Error(`Compiled child node "${context.nodeId}" retains root-only schedules.`);
  }
  if (resources.instrumentation.kind !== "none") {
    throw new Error(
      `Compiled child node "${context.nodeId}" retains a root-only instrumentation plan.`,
    );
  }
  if (resources.workflowTool !== undefined) {
    throw new Error(
      `Compiled child node "${context.nodeId}" retains root-only Workflow configuration.`,
    );
  }
  if ("config" in resources) {
    if (resources.config.experimental?.tasks !== undefined) {
      throw new Error(
        `Compiled child node "${context.nodeId}" cannot configure "experimental.tasks".`,
      );
    }
    if (resources.config.experimental?.instrumentationProviders !== undefined) {
      throw new Error(
        `Compiled child node "${context.nodeId}" cannot configure "experimental.instrumentationProviders".`,
      );
    }
  }
}

function isRootOnlySourceSlot(slot: string): boolean {
  return (
    slot === "instrumentation" ||
    slot.startsWith("instrumentation/") ||
    slot.startsWith("channels/") ||
    slot.startsWith("schedules/")
  );
}

function sameOwner(left: AgentSourceOwner, right: AgentSourceOwner): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "application":
      return true;
    case "framework":
      return right.kind === "framework" && left.feature === right.feature;
    case "extension":
      return (
        right.kind === "extension" &&
        left.namespace === right.namespace &&
        left.packageName === right.packageName
      );
  }
}

function sameModuleBacking(left: CompiledModuleBacking, right: CompiledModuleBacking): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "programmatic") {
    return (
      right.kind === "programmatic" &&
      left.moduleId === right.moduleId &&
      left.registryId === right.registryId &&
      left.revision === right.revision &&
      left.semanticRevision === right.semanticRevision
    );
  }
  if (right.kind !== "filesystem") return false;
  return (
    left.sourcePath === right.sourcePath &&
    left.externalDependencies.length === right.externalDependencies.length &&
    left.externalDependencies.every(
      (dependency, index) => dependency === right.externalDependencies[index],
    ) &&
    left.extensionScope?.namespace === right.extensionScope?.namespace &&
    left.extensionScope?.sourceRoot === right.extensionScope?.sourceRoot
  );
}

export function assertCompiledInstrumentationPlan(manifest: CompiledAgentManifest): void {
  const selected: Extract<AgentSourceComposition["selected"][number], { sourceKind: "module" }>[] =
    [];
  for (const source of manifest.sourceComposition.selected) {
    if (
      source.sourceKind === "module" &&
      (source.slot === "instrumentation" || source.slot.startsWith("instrumentation/"))
    ) {
      selected.push(source);
    }
  }
  const providersEnabled = manifest.config.experimental?.instrumentationProviders === true;

  if (providersEnabled) {
    if (manifest.instrumentation.kind !== "providers") {
      throw new Error("Compiled instrumentation provider mode requires a provider plan.");
    }
    if (selected.some((source) => source.slot === "instrumentation")) {
      throw new Error(
        'Compiled instrumentation provider mode cannot select the "instrumentation" file slot.',
      );
    }

    const expected = new Map(
      selected.map((source) => [source.slot.slice("instrumentation/".length), source] as const),
    );
    let previousSlot: string | undefined;
    for (const entry of manifest.instrumentation.entries) {
      if (previousSlot !== undefined && previousSlot.localeCompare(entry.slot) >= 0) {
        throw new Error(
          `Compiled instrumentation provider slot "${entry.slot}" is duplicated or out of canonical order.`,
        );
      }
      previousSlot = entry.slot;
      const source = expected.get(entry.slot);
      if (source === undefined || source.slot !== `instrumentation/${entry.slot}`) {
        throw new Error(
          `Compiled instrumentation provider plan references unselected slot "${entry.slot}".`,
        );
      }
      assertCompiledInstrumentationEntry({
        activation: entry.activation,
        binding: manifest.bindings[source.sourceId]!,
        implementation: entry.implementation,
        source: entry.source,
        sourceId: source.sourceId,
        slot: source.slot,
      });
      expected.delete(entry.slot);
    }
    if (expected.size > 0) {
      const [slot] = expected.keys();
      throw new Error(`Compiled instrumentation provider plan is missing selected slot "${slot}".`);
    }
    return;
  }

  if (selected.some((source) => source.slot !== "instrumentation")) {
    throw new Error(
      "Compiled instrumentation file mode cannot select instrumentation provider slots.",
    );
  }
  const source = selected[0];
  if (source === undefined) {
    if (manifest.instrumentation.kind !== "none") {
      throw new Error("Compiled instrumentation plan must be empty when its source is disabled.");
    }
    return;
  }
  if (selected.length !== 1 || manifest.instrumentation.kind !== "file") {
    throw new Error(
      'Compiled instrumentation file mode requires exactly one selected "instrumentation" source and file plan.',
    );
  }
  assertCompiledInstrumentationEntry({
    activation: manifest.instrumentation.entry.activation,
    binding: manifest.bindings[source.sourceId]!,
    implementation: manifest.instrumentation.entry.implementation,
    source: manifest.instrumentation.entry.source,
    sourceId: source.sourceId,
    slot: source.slot,
  });
}

function assertCompiledInstrumentationEntry(input: {
  readonly activation: "always" | "development" | "production";
  readonly binding: CompiledModuleBinding;
  readonly implementation: "config" | "local-tracing" | "provider";
  readonly source: ModuleSourceRef;
  readonly sourceId: string;
  readonly slot: string;
}): void {
  if (
    input.source.sourceId !== input.sourceId ||
    input.source.logicalPath !== input.binding.logicalPath ||
    input.source.exportName !== undefined
  ) {
    throw new Error(
      `Compiled instrumentation plan source for slot "${input.slot}" does not match its selected binding.`,
    );
  }

  const isFramework = input.binding.owner.kind === "framework";
  const expectedImplementation =
    input.slot === "instrumentation" ? (isFramework ? "local-tracing" : "config") : "provider";
  let expectedActivation: "always" | "development" | "production" = "always";
  if (isFramework) {
    if (input.slot === "instrumentation" || input.slot === "instrumentation/local") {
      expectedActivation = "development";
    } else if (input.slot === "instrumentation/agent-runs") {
      expectedActivation = "production";
    } else {
      throw new Error(
        `Compiled framework instrumentation slot "${input.slot}" has no runtime implementation.`,
      );
    }
  }
  if (input.implementation !== expectedImplementation || input.activation !== expectedActivation) {
    throw new Error(
      `Compiled instrumentation plan for slot "${input.slot}" does not match its selected owner.`,
    );
  }
}

export function assertSubagentComposition(manifest: CompiledAgentManifest): void {
  const nodesById = new Map<string, CompiledAgentManifest["subagents"][number]>();
  const allNodeIds = new Set<string>([ROOT_COMPILED_AGENT_NODE_ID]);
  for (const node of manifest.subagents) {
    if (node.nodeId === ROOT_COMPILED_AGENT_NODE_ID) {
      throw new Error('Compiled subagent node id "__root__" is reserved for the root agent.');
    }
    if (allNodeIds.has(node.nodeId)) {
      throw new Error(`Compiled agent node id "${node.nodeId}" is present more than once.`);
    }
    allNodeIds.add(node.nodeId);
    nodesById.set(node.nodeId, node);
  }
  const childParents = new Map<string, string>();
  for (const edge of manifest.subagentEdges) {
    if (!nodesById.has(edge.childNodeId)) {
      throw new Error(`Compiled subagent edge references missing child "${edge.childNodeId}".`);
    }
    if (edge.parentNodeId !== ROOT_COMPILED_AGENT_NODE_ID && !nodesById.has(edge.parentNodeId)) {
      throw new Error(`Compiled subagent edge references missing parent "${edge.parentNodeId}".`);
    }
    const existingParent = childParents.get(edge.childNodeId);
    if (existingParent !== undefined) {
      throw new Error(
        `Compiled subagent "${edge.childNodeId}" has multiple parent edges from "${existingParent}" and "${edge.parentNodeId}".`,
      );
    }
    childParents.set(edge.childNodeId, edge.parentNodeId);
  }
  for (const node of manifest.subagents) {
    const parentNodeId = childParents.get(node.nodeId);
    if (parentNodeId === undefined) {
      throw new Error(`Compiled subagent "${node.nodeId}" has no parent edge.`);
    }
    assertCanonicalCompiledAgentNodeId({
      nodeId: node.nodeId,
      parentNodeId,
      sourceId: node.sourceId,
      subject: "subagent",
    });
    assertCompiledSubagentPathSemantics(node, node.nodeId);
  }
  for (const node of manifest.subagents) {
    const ancestors = new Set<string>([node.nodeId]);
    let parentNodeId = childParents.get(node.nodeId)!;
    while (parentNodeId !== ROOT_COMPILED_AGENT_NODE_ID) {
      if (ancestors.has(parentNodeId)) {
        throw new Error(`Compiled subagent graph contains a cycle through "${parentNodeId}".`);
      }
      ancestors.add(parentNodeId);
      parentNodeId = childParents.get(parentNodeId)!;
    }
  }
  const resourcesById = new Map<string, CompiledAgentNodeManifest | CompiledAgentResources>([
    [ROOT_COMPILED_AGENT_NODE_ID, manifest],
    ...manifest.subagents.map((node) => [node.nodeId, node.agent] as const),
  ]);

  for (const [parentNodeId, resources] of resourcesById) {
    for (const remote of resources.remoteAgents) {
      assertCanonicalCompiledAgentNodeId({
        nodeId: remote.nodeId,
        parentNodeId,
        sourceId: remote.sourceId,
        subject: "remote subagent",
      });
      assertCompiledSubagentPathSemantics(remote, remote.nodeId);
      if (allNodeIds.has(remote.nodeId)) {
        throw new Error(`Compiled agent node id "${remote.nodeId}" is present more than once.`);
      }
      allNodeIds.add(remote.nodeId);
    }
    const selected = new Map(
      resources.sourceComposition.selected.flatMap((entry) =>
        entry.sourceKind === "non-module" && entry.source.sourceKind === "subagent"
          ? [[entry.slot, entry.source] as const]
          : [],
      ),
    );
    const directLocalNodes = manifest.subagentEdges
      .filter((edge) => edge.parentNodeId === parentNodeId)
      .map((edge) => nodesById.get(edge.childNodeId))
      .filter((node): node is CompiledAgentManifest["subagents"][number] => node !== undefined);
    const expectedSlots = new Set<string>();
    for (const node of [...directLocalNodes, ...resources.remoteAgents]) {
      const slot = `subagents/${node.name}`;
      if (expectedSlots.has(slot)) {
        throw new Error(
          `Compiled node "${parentNodeId}" contains multiple subagent nodes for slot "${slot}".`,
        );
      }
      expectedSlots.add(slot);
    }

    for (const slot of expectedSlots) {
      if (!selected.has(slot)) {
        throw new Error(
          `Compiled node "${parentNodeId}" is missing selected subagent source composition for "${slot}".`,
        );
      }
    }
    for (const slot of selected.keys()) {
      if (!expectedSlots.has(slot)) {
        throw new Error(
          `Compiled node "${parentNodeId}" selects dangling subagent source slot "${slot}".`,
        );
      }
    }
    for (const node of directLocalNodes) {
      const source = selected.get(`subagents/${node.name}`)!;
      if (source.sourceId !== node.sourceId || source.logicalPath !== node.logicalPath) {
        throw new Error(
          `Compiled subagent "${node.nodeId}" does not match its selected source composition.`,
        );
      }
      if (
        JSON.stringify(source.owner) !== JSON.stringify(node.owner) ||
        JSON.stringify(source.backing) !== JSON.stringify(node.backing)
      ) {
        throw new Error(
          `Compiled subagent "${node.nodeId}" does not preserve its selected owner and backing.`,
        );
      }
    }
    for (const node of resources.remoteAgents) {
      const source = selected.get(`subagents/${node.name}`)!;
      if (source.sourceId !== node.sourceId || source.logicalPath !== node.logicalPath) {
        throw new Error(
          `Compiled remote subagent "${node.nodeId}" does not match its selected source composition.`,
        );
      }
      if (
        JSON.stringify(source.owner) !== JSON.stringify(node.owner) ||
        JSON.stringify(source.backing) !== JSON.stringify(node.backing)
      ) {
        throw new Error(
          `Compiled remote subagent "${node.nodeId}" does not preserve its selected owner and backing.`,
        );
      }
    }
  }
}

function assertCompiledSubagentPathSemantics(
  source:
    | CompiledAgentManifest["subagents"][number]
    | CompiledAgentResources["remoteAgents"][number],
  nodeId: string,
): void {
  if (source.backing.kind !== "filesystem") return;
  if (source.entryPath !== source.backing.sourcePath) {
    throw new Error(
      `Compiled subagent "${nodeId}" entry path does not match its filesystem backing path.`,
    );
  }
  if (!isPathInside(source.rootPath, source.entryPath)) {
    throw new Error(
      `Compiled subagent "${nodeId}" entry path is outside its physical root "${source.rootPath}".`,
    );
  }
}

function isPathInside(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function assertCanonicalCompiledAgentNodeId(input: {
  readonly nodeId: string;
  readonly parentNodeId: string;
  readonly sourceId: string;
  readonly subject: "remote subagent" | "subagent";
}): void {
  const expected = createCompiledSubagentNodeId(input.parentNodeId, input.sourceId);
  if (input.nodeId !== expected) {
    throw new Error(
      `Compiled ${input.subject} node id "${input.nodeId}" does not match canonical id "${expected}" for parent "${input.parentNodeId}" and source "${input.sourceId}".`,
    );
  }
}
