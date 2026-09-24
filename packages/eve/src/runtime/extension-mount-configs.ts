import { ContextContainer, contextStorage } from "#context/container.js";
import { ExtensionConfigsKey } from "#context/keys.js";
import { type CompiledAgentManifest, ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import {
  installScopedExtensionConfigResolver,
  readMountedExtensionConfig,
} from "#public/definitions/extension.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

type Config = Record<string, unknown>;
type ExtensionConfigs = ReadonlyMap<string, Config>;

interface MountNode {
  readonly agent: { readonly extensionMounts: CompiledAgentManifest["extensionMounts"] };
  readonly parentNodeId?: string;
}

/**
 * Resolves every agent node's extension mount configs, keyed by compiled node
 * id, so one extension mounted in several agents keeps each mount's config. A
 * node without its own mount of an extension (for example a subagent the
 * extension ships) inherits its parent's.
 *
 * The result belongs to this graph only; the runtime stores it on the resolved
 * nodes so concurrent or reloaded graphs never share it.
 */
export function resolveExtensionMountConfigs(
  manifest: CompiledAgentManifest,
  moduleMap: CompiledModuleMap,
): ReadonlyMap<string, ExtensionConfigs> {
  installScopedExtensionConfigResolver(resolveScopedExtensionConfig);
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
      if (config !== undefined) configs.set(mount.packageNamespace, config);
    }
    effectiveByNodeId.set(nodeId, configs);
    return configs;
  };

  for (const nodeId of nodesById.keys()) effectiveConfigs(nodeId);
  return effectiveByNodeId;
}

/**
 * Runs `callback` in a scope where extension handles read `configs`. Used by
 * ingress without a session bundle, such as channel requests. Values of the
 * surrounding scope are carried over.
 */
export async function withExtensionConfigs<T>(
  configs: ExtensionConfigs,
  callback: () => Promise<T>,
): Promise<T> {
  const scope = new ContextContainer();
  for (const [key, value] of contextStorage.getStore()?.entries() ?? []) {
    scope.set(key, value);
  }
  scope.setVirtualContext(ExtensionConfigsKey, configs);
  return await contextStorage.run(scope, callback);
}

/**
 * Looks up the config of the active scope: the node of the session bundle,
 * else the configs an ingress scope set. Both hold graph-owned values, so a
 * session on one graph generation never reads another generation's configs.
 */
function resolveScopedExtensionConfig(namespace: string): Config | undefined {
  const ctx = contextStorage.getStore();
  if (ctx === undefined) return undefined;
  const bundle = ctx.get(BundleKey);
  if (bundle !== undefined) {
    const node =
      bundle.nodeId === undefined
        ? bundle.graph.root
        : bundle.graph.nodesByNodeId.get(bundle.nodeId);
    return node?.extensionConfigs.get(namespace);
  }
  return ctx.get(ExtensionConfigsKey)?.get(namespace);
}
