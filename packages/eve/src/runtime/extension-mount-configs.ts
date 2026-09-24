import { contextStorage } from "#context/container.js";
import { type CompiledAgentManifest, ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import {
  bindExtensionNodeConfigs,
  readMountedExtensionConfig,
} from "#public/definitions/extension.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

type Config = Record<string, unknown>;

interface MountNode {
  readonly agent: { readonly extensionMounts: CompiledAgentManifest["extensionMounts"] };
  readonly parentNodeId?: string;
}

/**
 * Binds every agent node's extension mount config so one extension mounted in
 * several agents keeps each mount's config. A node without its own mount of an
 * extension (for example a subagent the extension ships) inherits its parent's.
 */
export function bindExtensionMountConfigs(
  manifest: CompiledAgentManifest,
  moduleMap: CompiledModuleMap,
): void {
  const nodesById = new Map<string, MountNode>([
    [ROOT_COMPILED_AGENT_NODE_ID, { agent: manifest }],
  ]);
  for (const subagent of manifest.subagents) {
    nodesById.set(subagent.nodeId, subagent);
  }
  const effectiveByNodeId = new Map<string, ReadonlyMap<string, Config>>();

  const effectiveConfigs = (nodeId: string): ReadonlyMap<string, Config> => {
    const cached = effectiveByNodeId.get(nodeId);
    if (cached !== undefined) return cached;
    const node = nodesById.get(nodeId);
    const configs = new Map(
      node?.parentNodeId === undefined ? [] : effectiveConfigs(node.parentNodeId),
    );
    for (const mount of node?.agent.extensionMounts ?? []) {
      const config = readMountedExtensionConfig(
        moduleMap.nodes[nodeId]?.modules[mount.mountSourceId]?.default,
      );
      if (config !== undefined) configs.set(mount.packageNamespace, config);
    }
    effectiveByNodeId.set(nodeId, configs);
    return configs;
  };

  const configsByNamespace = new Map<string, Map<string, Config>>();
  for (const nodeId of nodesById.keys()) {
    for (const [namespace, config] of effectiveConfigs(nodeId)) {
      let configs = configsByNamespace.get(namespace);
      if (configs === undefined) {
        configs = new Map();
        configsByNamespace.set(namespace, configs);
      }
      configs.set(nodeId, config);
    }
  }

  bindExtensionNodeConfigs(configsByNamespace, currentSessionNodeId);
}

/** The agent node of the active session; root bundles carry no node id. */
function currentSessionNodeId(): string | undefined {
  const bundle = contextStorage.getStore()?.get(BundleKey);
  if (bundle === undefined) return undefined;
  return bundle.nodeId ?? ROOT_COMPILED_AGENT_NODE_ID;
}
