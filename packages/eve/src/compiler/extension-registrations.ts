import { isAbsolute, relative, resolve } from "node:path";

import type {
  CompiledAgentManifest,
  CompiledAgentNodeManifest,
  CompiledAgentResources,
  CompiledExtensionMount,
} from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";

/** One extension mount, identified by the absolute path of its mount module. */
export interface CompiledExtensionRegistration {
  readonly id: string;
  readonly mount: CompiledExtensionMount;
}

export interface CompiledExtensionRegistrationIndex {
  readonly byMountSourceIdByNodeId: ReadonlyMap<
    string,
    ReadonlyMap<string, CompiledExtensionRegistration>
  >;
  readonly byNamespaceByNodeId: ReadonlyMap<
    string,
    ReadonlyMap<string, readonly CompiledExtensionRegistration[]>
  >;
  readonly agentRootByNodeId: ReadonlyMap<string, string>;
  readonly registrations: readonly CompiledExtensionRegistration[];
}

/** Builds local registrations plus inherited registrations for extension subagents. */
export function createCompiledExtensionRegistrationIndex(
  manifest: CompiledAgentManifest,
): CompiledExtensionRegistrationIndex {
  const nodeManifests = new Map<string, CompiledAgentNodeManifest | CompiledAgentResources>([
    [ROOT_COMPILED_AGENT_NODE_ID, manifest],
    ...manifest.subagents.map((subagent) => [subagent.nodeId, subagent.agent] as const),
  ]);
  const parentNodeIdByChild = new Map(
    manifest.subagentEdges.map((edge) => [edge.childNodeId, edge.parentNodeId]),
  );
  const byNamespaceByNodeId = new Map<
    string,
    ReadonlyMap<string, readonly CompiledExtensionRegistration[]>
  >();
  const byMountSourceIdByNodeId = new Map<
    string,
    ReadonlyMap<string, CompiledExtensionRegistration>
  >();
  const registrations: CompiledExtensionRegistration[] = [];

  const registrationsForNode = (
    nodeId: string,
  ): ReadonlyMap<string, readonly CompiledExtensionRegistration[]> => {
    const cached = byNamespaceByNodeId.get(nodeId);
    if (cached !== undefined) return cached;

    const node = nodeManifests.get(nodeId);
    const parentNodeId = parentNodeIdByChild.get(nodeId);
    const inherited = new Map(
      parentNodeId === undefined
        ? []
        : [...registrationsForNode(parentNodeId)].map(([namespace, entries]) => [
            namespace,
            [...entries],
          ]),
    );
    const localBySourceId = new Map<string, CompiledExtensionRegistration>();
    for (const mount of node?.extensionMounts ?? []) {
      const registration = {
        id: resolve(node!.agentRoot, mount.mountLogicalPath),
        mount,
      } satisfies CompiledExtensionRegistration;
      inherited.set(mount.namespace, [...(inherited.get(mount.namespace) ?? []), registration]);
      localBySourceId.set(mount.mountSourceId, registration);
      registrations.push(registration);
    }
    byNamespaceByNodeId.set(nodeId, inherited);
    byMountSourceIdByNodeId.set(nodeId, localBySourceId);
    return inherited;
  };

  registrationsForNode(ROOT_COMPILED_AGENT_NODE_ID);
  for (const subagent of manifest.subagents) registrationsForNode(subagent.nodeId);

  return {
    agentRootByNodeId: new Map(
      [...nodeManifests].map(([nodeId, nodeManifest]) => [nodeId, nodeManifest.agentRoot]),
    ),
    byMountSourceIdByNodeId,
    byNamespaceByNodeId,
    registrations,
  };
}

export function extensionRegistrationForSourceId(
  sourceId: string,
  logicalPath: string,
  nodeId: string,
  index: CompiledExtensionRegistrationIndex,
): CompiledExtensionRegistration | undefined {
  const mount = index.byMountSourceIdByNodeId.get(nodeId)?.get(sourceId);
  if (mount !== undefined) return mount;

  const match = sourceId.match(/^ext:([^:]+):/);
  if (match === null) return undefined;
  const candidates = index.byNamespaceByNodeId.get(nodeId)?.get(match[1]!);
  if (candidates === undefined) return undefined;
  const agentRoot = index.agentRootByNodeId.get(nodeId);
  if (agentRoot === undefined) return candidates.at(-1);
  const sourcePath = resolve(agentRoot, logicalPath);
  return (
    candidates.findLast((candidate) => isWithin(sourcePath, candidate.mount.sourceRoot)) ??
    candidates.at(-1)
  );
}

function isWithin(path: string, directory: string): boolean {
  const relativePath = relative(resolve(directory), path);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
