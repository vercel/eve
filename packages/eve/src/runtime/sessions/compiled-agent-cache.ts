import { pathToFileURL } from "node:url";

import type { CompiledModuleMap } from "#compiler/module-map.js";
import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";
import { resolveRuntimeCompiledArtifactsVersionedCacheKey } from "#runtime/cache-key.js";
import type { RuntimeAdapterRegistry } from "#runtime/channels/registry.js";
import { createRuntimeAdapterRegistry } from "#runtime/channels/registry.js";
import {
  getRuntimeCompiledArtifactsCacheKey,
  type RuntimeDiskCompiledArtifactsSource,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { getResolvedRuntimeAgentNode, type ResolvedAgentGraphBundle } from "#runtime/graph.js";
import type { RuntimeHookRegistry } from "#runtime/hooks/registry.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { loadCompiledModuleMap } from "#runtime/loaders/module-map.js";
import { resolveRuntimeAgentGraph } from "#runtime/resolve-agent-graph.js";
import type { RuntimeSubagentRegistry } from "#runtime/subagents/registry.js";
import type { RuntimeToolRegistry } from "#runtime/tools/registry.js";
import type { ResolvedAgent } from "#runtime/types.js";
import { getActiveRuntimeSession } from "#runtime/sessions/runtime-session.js";

export interface CompiledRuntimeAgentBundle {
  readonly adapterRegistry: RuntimeAdapterRegistry;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly graph: ResolvedAgentGraphBundle;
  readonly hookRegistry: RuntimeHookRegistry;
  readonly moduleMap: CompiledModuleMap;
  /**
   * Id of the active node in the graph. `undefined` for root bundles.
   * Persisted by the BundleKey codec so per-node bundles survive
   * serialization across workflow step boundaries.
   */
  readonly nodeId?: string;
  readonly resolvedAgent: ResolvedAgent;
  readonly subagentRegistry: RuntimeSubagentRegistry;
  readonly toolRegistry: RuntimeToolRegistry;
  readonly turnAgent: RuntimeTurnAgent;
}

const isCacheDisabled = process.env.EVE_DISABLE_AGENT_CACHE === "1";

async function loadFullBundle(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): Promise<CompiledRuntimeAgentBundle> {
  const [manifest, moduleMap] = await Promise.all([
    loadCompiledManifest({ compiledArtifactsSource }),
    loadRuntimeCompiledModuleMap(compiledArtifactsSource),
  ]);
  const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });
  const rootNode = graph.root;

  return {
    adapterRegistry: createRuntimeAdapterRegistry({
      channels: collectResolvedChannels(graph),
    }),
    compiledArtifactsSource,
    graph,
    hookRegistry: rootNode.hookRegistry,
    moduleMap,
    resolvedAgent: rootNode.agent,
    subagentRegistry: rootNode.subagentRegistry,
    toolRegistry: rootNode.toolRegistry,
    turnAgent: rootNode.turnAgent,
  };
}

async function loadRuntimeCompiledModuleMap(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): Promise<CompiledModuleMap> {
  if (
    compiledArtifactsSource.kind === "disk" &&
    compiledArtifactsSource.moduleMapLoaderPath !== undefined
  ) {
    return await loadAuthoredSourceCompiledModuleMap(compiledArtifactsSource);
  }

  return await loadCompiledModuleMap({ compiledArtifactsSource });
}

async function loadAuthoredSourceCompiledModuleMap(
  compiledArtifactsSource: RuntimeDiskCompiledArtifactsSource,
): Promise<CompiledModuleMap> {
  if (compiledArtifactsSource.moduleMapLoaderPath === undefined) {
    throw new Error(
      'Authored-source module map loading requires "moduleMapLoaderPath" in the compiled artifacts source.',
    );
  }

  const loader = (await import(
    pathToFileURL(compiledArtifactsSource.moduleMapLoaderPath).href
  )) as typeof import("#internal/authored-module-map-loader.js");

  return await loader.loadCompiledModuleMapFromAuthoredSource({
    compiledArtifactsSource,
  });
}

async function getOrLoadFullBundle(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): Promise<CompiledRuntimeAgentBundle> {
  if (isCacheDisabled) {
    return loadFullBundle(compiledArtifactsSource);
  }

  const session = getActiveRuntimeSession();
  const sourceKey = getRuntimeCompiledArtifactsCacheKey(compiledArtifactsSource);
  const cacheKey = await resolveRuntimeCompiledArtifactsVersionedCacheKey(compiledArtifactsSource);
  const previousKey = session.bundleCacheKeyBySourceKey.get(sourceKey);

  if (previousKey !== undefined && previousKey !== cacheKey) {
    session.bundleCache.delete(previousKey);
  }

  session.bundleCacheKeyBySourceKey.set(sourceKey, cacheKey);
  const cached = session.bundleCache.get(cacheKey);

  if (cached !== undefined) {
    return cached;
  }

  const bundlePromise = loadFullBundle(compiledArtifactsSource).catch((error) => {
    session.bundleCache.delete(cacheKey);

    if (session.bundleCacheKeyBySourceKey.get(sourceKey) === cacheKey) {
      session.bundleCacheKeyBySourceKey.delete(sourceKey);
    }

    throw error;
  });

  session.bundleCache.set(cacheKey, bundlePromise);
  return bundlePromise;
}

/**
 * Returns a compiled runtime agent bundle for the given source and optional
 * node id.
 *
 * The full graph is loaded and cached once per `compiledArtifactsSource`.
 * When `nodeId` is provided, a cheap per-node bundle is derived from
 * the cached graph with the node-level fields (turn agent, registries, etc.)
 * pointing at the target node. When omitted the root bundle is returned.
 */
export async function getCompiledRuntimeAgentBundle(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId?: string;
}): Promise<CompiledRuntimeAgentBundle> {
  const fullBundle = await getOrLoadFullBundle(input.compiledArtifactsSource);

  if (input.nodeId === undefined) {
    return fullBundle;
  }

  const node = getResolvedRuntimeAgentNode(fullBundle.graph, input.nodeId);
  return {
    adapterRegistry: fullBundle.adapterRegistry,
    compiledArtifactsSource: fullBundle.compiledArtifactsSource,
    graph: {
      nodesByNodeId: fullBundle.graph.nodesByNodeId,
      root: node,
    },
    hookRegistry: node.hookRegistry,
    moduleMap: fullBundle.moduleMap,
    nodeId: input.nodeId,
    resolvedAgent: node.agent,
    subagentRegistry: node.subagentRegistry,
    toolRegistry: node.toolRegistry,
    turnAgent: node.turnAgent,
  };
}

/**
 * Clears all cached compiled runtime agent bundles on the active runtime
 * session. The dev-server file watcher uses this to invalidate cached
 * bundles when authored source changes; tests rely on per-session isolation
 * so the process default cache is untouched when called inside a scoped
 * session.
 */
export function clearCompiledRuntimeAgentBundleCache(): void {
  const session = getActiveRuntimeSession();

  session.bundleCache.clear();
  session.bundleCacheKeyBySourceKey.clear();
}

function collectResolvedChannels(bundle: ResolvedAgentGraphBundle) {
  const channels = new Map<string, ResolvedAgentGraphBundle["root"]["channels"][number]>();

  for (const node of bundle.nodesByNodeId.values()) {
    for (const channel of node.channels) {
      channels.set(`${channel.sourceId}:${channel.name}`, channel);
    }
  }

  return [...channels.values()];
}
