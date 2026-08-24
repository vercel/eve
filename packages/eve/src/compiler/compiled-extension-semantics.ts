import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/compiled-agent-node-id.js";
import type {
  CompiledAgentManifest,
  CompiledAgentNodeManifest,
  CompiledAgentResources,
} from "#compiler/manifest.js";
import type { AgentSourceOwner, CompiledModuleBacking } from "#compiler/module-binding.js";
import { assertCompiledModuleBindingSemantics } from "#compiler/module-binding-semantics.js";
import { SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS } from "#discover/filesystem.js";
import { packageStateNamespace } from "#shared/extension-state-namespace.js";

/** Validates the runtime extension mount identity retained by one compiled node. */
export function assertCompiledExtensionMountSemantics(
  resources: CompiledAgentNodeManifest | CompiledAgentResources,
  nodeId: string,
): void {
  const mountNamespaces = new Set<string>();
  const mountSourceIds = new Set<string>();
  const selectedMountSourceIds = new Set(
    resources.sourceComposition.selected.flatMap((selected) => {
      if (selected.sourceKind !== "module") return [];
      const binding = resources.bindings[selected.sourceId];
      return binding !== undefined && binding.logicalPath.startsWith("extensions/")
        ? [selected.sourceId]
        : [];
    }),
  );
  for (const mount of resources.extensionMounts) {
    if (mountNamespaces.has(mount.namespace)) {
      throw new Error(
        `Compiled node "${nodeId}" repeats extension mount namespace "${mount.namespace}".`,
      );
    }
    mountNamespaces.add(mount.namespace);
    if (mountSourceIds.has(mount.mountSourceId)) {
      throw new Error(
        `Compiled node "${nodeId}" repeats extension mount source "${mount.mountSourceId}".`,
      );
    }
    mountSourceIds.add(mount.mountSourceId);

    const expectedPackageNamespace = packageStateNamespace(mount.packageName);
    if (mount.packageNamespace !== expectedPackageNamespace) {
      throw new Error(
        `Compiled node "${nodeId}" extension mount "${mount.namespace}" records package namespace "${mount.packageNamespace}" instead of "${expectedPackageNamespace}".`,
      );
    }
    if (!isCanonicalExtensionMountLogicalPath(mount.mountLogicalPath, mount.namespace)) {
      throw new Error(
        `Compiled node "${nodeId}" extension mount "${mount.namespace}" does not match logical path "${mount.mountLogicalPath}".`,
      );
    }
    const binding = resources.bindings[mount.mountSourceId];
    if (
      binding === undefined ||
      binding.logicalPath !== mount.mountLogicalPath ||
      binding.backing.kind !== "filesystem"
    ) {
      throw new Error(
        `Compiled node "${nodeId}" extension mount "${mount.namespace}" does not preserve its selected filesystem binding.`,
      );
    }
    assertCompiledModuleBindingSemantics({
      binding,
      nodeId,
      sourceId: mount.mountSourceId,
    });
    selectedMountSourceIds.delete(mount.mountSourceId);

    for (const [sourceId, extensionBinding] of Object.entries(resources.bindings)) {
      if (
        extensionBinding.owner.kind !== "extension" ||
        extensionBinding.owner.namespace !== mount.namespace ||
        extensionBinding.owner.packageName !== mount.packageName ||
        extensionBinding.backing.kind !== "filesystem"
      ) {
        continue;
      }
      if (extensionBinding.backing.extensionScope?.sourceRoot !== mount.sourceRoot) {
        throw new Error(
          `Compiled node "${nodeId}" extension source "${sourceId}" does not match mount "${mount.namespace}" source root "${mount.sourceRoot}".`,
        );
      }
    }
  }
  const missingMountSourceId = selectedMountSourceIds.values().next().value as string | undefined;
  if (missingMountSourceId !== undefined) {
    throw new Error(
      `Compiled node "${nodeId}" selects extension mount source "${missingMountSourceId}" without a compiled mount record.`,
    );
  }
}

function isCanonicalExtensionMountLogicalPath(logicalPath: string, namespace: string): boolean {
  const extension = SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS.find((candidate) =>
    logicalPath.endsWith(candidate),
  );
  if (extension === undefined) return false;
  const stem = logicalPath.slice(0, -extension.length);
  return stem === `extensions/${namespace}` || stem === `extensions/${namespace}/extension`;
}

interface CompiledExtensionAuthority {
  readonly namespace: string;
  readonly packageName: string;
  readonly sourceRoot: string;
}

/** Proves every extension-owned source descends from one exact mounted package. */
export function assertCompiledExtensionProvenance(manifest: CompiledAgentManifest): void {
  const nodesById = new Map(manifest.subagents.map((node) => [node.nodeId, node] as const));
  const childrenByParent = new Map<string, CompiledAgentManifest["subagents"][number][]>();
  for (const edge of manifest.subagentEdges) {
    const child = nodesById.get(edge.childNodeId);
    if (child === undefined) continue;
    const children = childrenByParent.get(edge.parentNodeId) ?? [];
    children.push(child);
    childrenByParent.set(edge.parentNodeId, children);
  }

  const visit = (
    nodeId: string,
    resources: CompiledAgentNodeManifest | CompiledAgentResources,
    inheritedAuthority?: CompiledExtensionAuthority,
  ): void => {
    const inheritedAuthorities = inheritedAuthority === undefined ? [] : [inheritedAuthority];
    for (const mount of resources.extensionMounts) {
      const declaration = resources.bindings[mount.mountSourceId];
      if (declaration === undefined) continue;
      if (inheritedAuthority === undefined && declaration.owner.kind === "application") continue;
      if (declaration.owner.kind !== "extension") {
        throw new Error(
          `Compiled node "${nodeId}" extension mount "${mount.namespace}" is not declared by its pre-existing node authority.`,
        );
      }
      assertExtensionSourceAuthority({
        authorities: inheritedAuthorities,
        backing: declaration.backing,
        nodeId,
        owner: declaration.owner,
        sourceId: mount.mountSourceId,
      });
    }
    const authorities = [
      ...inheritedAuthorities,
      ...resources.extensionMounts.map((mount): CompiledExtensionAuthority => ({
        namespace: mount.namespace,
        packageName: mount.packageName,
        sourceRoot: mount.sourceRoot,
      })),
    ];
    assertCompiledResourceExtensionAuthorities(resources, nodeId, authorities);

    for (const remote of resources.remoteAgents) {
      assertExtensionSourceAuthority({
        authorities,
        backing: remote.backing,
        nodeId,
        owner: remote.owner,
        sourceId: remote.sourceId,
      });
      const remoteAuthority = extensionAuthorityForSource(remote.owner, remote.backing);
      assertCompiledResourceExtensionAuthorities(
        {
          ...resources,
          bindings: remote.bindings,
          extensionMounts: [],
          sourceComposition: remote.sourceComposition,
        },
        remote.nodeId,
        remoteAuthority === undefined ? [] : [remoteAuthority],
      );
    }

    for (const child of childrenByParent.get(nodeId) ?? []) {
      assertExtensionSourceAuthority({
        authorities,
        backing: child.backing,
        nodeId,
        owner: child.owner,
        sourceId: child.sourceId,
      });
      visit(child.nodeId, child.agent, extensionAuthorityForSource(child.owner, child.backing));
    }
  };

  visit(ROOT_COMPILED_AGENT_NODE_ID, manifest);
}

function assertCompiledResourceExtensionAuthorities(
  resources: CompiledAgentNodeManifest | CompiledAgentResources,
  nodeId: string,
  authorities: readonly CompiledExtensionAuthority[],
): void {
  for (const [sourceId, binding] of Object.entries(resources.bindings)) {
    assertExtensionSourceAuthority({
      authorities,
      backing: binding.backing,
      nodeId,
      owner: binding.owner,
      sourceId,
    });
  }
  for (const retained of [
    ...resources.sourceComposition.selected.flatMap((selected) =>
      selected.sourceKind === "non-module" ? [selected.source] : [],
    ),
    ...resources.sourceComposition.disabled.map((entry) => entry.source),
    ...resources.sourceComposition.shadowed.map((entry) => entry.source),
  ]) {
    if ("backing" in retained) {
      assertExtensionSourceAuthority({
        authorities,
        backing: retained.backing,
        nodeId,
        owner: retained.owner,
        sourceId: retained.sourceId,
      });
    } else {
      assertExtensionSourceAuthority({
        authorities,
        nodeId,
        owner: retained.owner,
        sourceId: retained.sourceId,
      });
    }
  }
}

function assertExtensionSourceAuthority(input: {
  readonly authorities: readonly CompiledExtensionAuthority[];
  readonly backing?: CompiledModuleBacking;
  readonly nodeId: string;
  readonly owner: AgentSourceOwner;
  readonly sourceId: string;
}): void {
  if (input.owner.kind !== "extension") return;
  const namespace = input.owner.namespace;
  const packageName = input.owner.packageName;
  const authority = input.authorities.find(
    (candidate) =>
      candidate.namespace === namespace &&
      candidate.packageName === packageName &&
      (input.backing?.kind !== "filesystem" ||
        candidate.sourceRoot === input.backing.extensionScope?.sourceRoot),
  );
  if (authority === undefined) {
    throw new Error(
      `Compiled node "${input.nodeId}" extension-owned source "${input.sourceId}" does not descend from an exact mounted package authority.`,
    );
  }
}

function extensionAuthorityForSource(
  ownerValue: AgentSourceOwner,
  backing: CompiledModuleBacking,
): CompiledExtensionAuthority | undefined {
  if (ownerValue.kind !== "extension") return undefined;
  if (backing.kind !== "filesystem") return undefined;
  const sourceRoot = backing.extensionScope?.sourceRoot;
  if (sourceRoot === undefined) return undefined;
  return {
    namespace: ownerValue.namespace,
    packageName: ownerValue.packageName,
    sourceRoot,
  };
}
