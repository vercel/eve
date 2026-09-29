import { ContextContainer, contextStorage } from "#context/container.js";
import { ExtensionConfigsKey } from "#context/keys.js";
import { type CompiledAgentManifest, ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import {
  installScopedExtensionConfigsResolver,
  readMountedExtensionConfig,
} from "#public/definitions/extension.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

type Config = Record<string, unknown>;
type ExtensionConfigs = ReadonlyMap<string, Config>;

interface MountNode {
  readonly agent: { readonly extensionMounts: CompiledAgentManifest["extensionMounts"] };
  readonly parentNodeId?: string;
}

// A session bundle points `graph.root` at its own node, so its configs win over
// any ingress configs an enclosing scope set.
installScopedExtensionConfigsResolver(() => {
  const ctx = contextStorage.getStore();
  return ctx?.get(BundleKey)?.graph.root.extensionConfigs ?? ctx?.get(ExtensionConfigsKey);
});

/**
 * Resolves every agent node's extension mount configs, keyed by compiled node
 * id, so one extension mounted in several agents keeps each mount's config. A
 * node without its own mount of an extension (for example a subagent the
 * extension ships) inherits its parent's; a node's own bare mount uses the
 * schema defaults.
 *
 * The result belongs to this graph only; the runtime stores it on the resolved
 * nodes so concurrent or reloaded graphs never share it.
 */
export function resolveExtensionMountConfigs(
  manifest: CompiledAgentManifest,
  moduleMap: CompiledModuleMap,
): ReadonlyMap<string, ExtensionConfigs> {
  const nodesById = new Map<string, MountNode>([
    [ROOT_COMPILED_AGENT_NODE_ID, { agent: manifest }],
  ]);
  for (const subagent of manifest.subagents) {
    nodesById.set(subagent.nodeId, subagent);
  }
  const effectiveByNodeId = new Map<string, ExtensionConfigs>();

  const effectiveConfigs = (nodeId: string): ExtensionConfigs => {
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
      if (config === undefined) configs.delete(mount.packageNamespace);
      else configs.set(mount.packageNamespace, config);
    }
    effectiveByNodeId.set(nodeId, configs);
    return configs;
  };

  for (const nodeId of nodesById.keys()) effectiveConfigs(nodeId);
  return effectiveByNodeId;
}

/**
 * Runs `callback` in a fresh ingress scope where extension handles read
 * `configs`. Used by channel requests and websocket callbacks, which carry no
 * session bundle. Like every ingress scope, it inherits only the dev-TUI hint.
 */
export function withExtensionConfigs<T>(configs: ExtensionConfigs, callback: () => T): T {
  const scope = new ContextContainer();
  scope.setVirtualContext(ExtensionConfigsKey, configs);
  return contextStorage.run(scope, callback);
}
