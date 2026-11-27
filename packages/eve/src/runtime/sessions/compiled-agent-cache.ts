import { pathToFileURL } from "node:url";

import type { CompiledModuleMap } from "#compiler/module-map.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import type { ModelMetadata } from "#internal/model-catalog.js";
import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";
import { materializeCompiledArtifactsSource } from "#runtime/compiled-artifacts-override.js";
import { resolveRuntimeCompiledArtifactsVersionedCacheKey } from "#runtime/cache-key.js";
import type { RuntimeAdapterRegistry } from "#runtime/channels/registry.js";
import { createRuntimeAdapterRegistry } from "#runtime/channels/registry.js";
import {
  getRuntimeCompiledArtifactsCacheKey,
  type RuntimeDiskCompiledArtifactsSource,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { getResolvedRuntimeAgentNode, type ResolvedAgentGraphBundle } from "#runtime/graph.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { loadModelMetadata } from "#runtime/loaders/model-metadata.js";
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
  readonly modelMetadata: () => Promise<ModelMetadata>;
  readonly moduleMap: CompiledModuleMap;
  readonly nodeId?: string;
  readonly resolvedAgent: ResolvedAgent;
  readonly subagentRegistry: RuntimeSubagentRegistry;
  readonly toolRegistry: RuntimeToolRegistry;
  readonly turnAgent: RuntimeTurnAgent;
}

const isCacheDisabled = process.env.EVE_DISABLE_AGENT_CACHE === "1";

const DEVELOPMENT_RUNTIME_SNAPSHOT_SEGMENT =
  /\/\.eve\/(?:eval-servers\/[^/]+\/)?dev-runtime\/snapshots\//;

function isDevelopmentRuntimeSnapshotRoot(appRoot: string): boolean {
  return DEVELOPMENT_RUNTIME_SNAPSHOT_SEGMENT.test(appRoot.replaceAll("\\", "/"));
}

function normalizeCompiledArtifactsSource(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): RuntimeCompiledArtifactsSource {
  if (
    compiledArtifactsSource.kind !== "disk" ||
    compiledArtifactsSource.moduleMapLoaderPath !== undefined ||
    !isDevelopmentRuntimeSnapshotRoot(compiledArtifactsSource.appRoot)
  ) {
    return compiledArtifactsSource;
  }

  return {
    ...compiledArtifactsSource,
    moduleMapLoaderPath: resolvePackageSourceFilePath("src/internal/authored-module-map-loader.ts"),
  };
}

async function loadFullBundle(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): Promise<CompiledRuntimeAgentBundle> {
  const normalizedCompiledArtifactsSource =
    normalizeCompiledArtifactsSource(compiledArtifactsSource);
  const [manifest, moduleMap] = await Promise.all([
    loadCompiledManifest({ compiledArtifactsSource: normalizedCompiledArtifactsSource }),
    loadRuntimeCompiledModuleMap(normalizedCompiledArtifactsSource),
  ]);
  const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });
  const rootNode = graph.root;
  let modelMetadata: Promise<ModelMetadata> | undefined;

  return {
    adapterRegistry: createRuntimeAdapterRegistry({
      channels: collectResolvedChannels(graph),
    }),
    compiledArtifactsSource: normalizedCompiledArtifactsSource,
    graph,
    modelMetadata: () => {
      modelMetadata ??= loadModelMetadata(normalizedCompiledArtifactsSource).catch(
        (error: unknown) => {
          modelMetadata = undefined;
          throw error;
        },
      );
      return modelMetadata;
    },
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
  const normalizedCompiledArtifactsSource =
    normalizeCompiledArtifactsSource(compiledArtifactsSource);

  await materializeCompiledArtifactsSource(normalizedCompiledArtifactsSource);

  if (isCacheDisabled) {
    return loadFullBundle(normalizedCompiledArtifactsSource);
  }

  const session = getActiveRuntimeSession();
  const sourceKey = getRuntimeCompiledArtifactsCacheKey(normalizedCompiledArtifactsSource);
  const cacheKey = await resolveRuntimeCompiledArtifactsVersionedCacheKey(
    normalizedCompiledArtifactsSource,
  );
  const previousKey = session.bundleCacheKeyBySourceKey.get(sourceKey);

  if (previousKey !== undefined && previousKey !== cacheKey) {
    session.bundleCache.delete(previousKey);
  }

  session.bundleCacheKeyBySourceKey.set(sourceKey, cacheKey);
  const cached = session.bundleCache.get(cacheKey);

  if (cached !== undefined) {
    return cached;
  }

  const bundlePromise = loadFullBundle(normalizedCompiledArtifactsSource).catch((error) => {
    session.bundleCache.delete(cacheKey);

    if (session.bundleCacheKeyBySourceKey.get(sourceKey) === cacheKey) {
      session.bundleCacheKeyBySourceKey.delete(sourceKey);
    }

    throw error;
  });

  session.bundleCache.set(cacheKey, bundlePromise);
  return bundlePromise;
}

export async function getCompiledRuntimeAgentBundle(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId?: string;
}): Promise<CompiledRuntimeAgentBundle> {
  const fullBundle = await getOrLoadFullBundle(input.compiledArtifactsSource);

  if (input.nodeId === undefined) {
    return fullBundle;
  }

  let nodeBundles = nodeBundlesByFullBundle.get(fullBundle);
  if (nodeBundles === undefined) {
    nodeBundles = new Map();
    nodeBundlesByFullBundle.set(fullBundle, nodeBundles);
  }
  const known = nodeBundles.get(input.nodeId);
  if (known !== undefined) return known;
  const nodeBundle = createNodeBundle(fullBundle, input.nodeId);
  nodeBundles.set(input.nodeId, nodeBundle);
  return nodeBundle;
}

const nodeBundlesByFullBundle = new WeakMap<
  CompiledRuntimeAgentBundle,
  Map<string, CompiledRuntimeAgentBundle>
>();

function createNodeBundle(
  fullBundle: CompiledRuntimeAgentBundle,
  nodeId: string,
): CompiledRuntimeAgentBundle {
  const node = getResolvedRuntimeAgentNode(fullBundle.graph, nodeId);
  return {
    adapterRegistry: fullBundle.adapterRegistry,
    compiledArtifactsSource: fullBundle.compiledArtifactsSource,
    graph: {
      nodesByNodeId: fullBundle.graph.nodesByNodeId,
      root: node,
    },
    modelMetadata: fullBundle.modelMetadata,
    moduleMap: fullBundle.moduleMap,
    nodeId,
    resolvedAgent: node.agent,
    subagentRegistry: node.subagentRegistry,
    toolRegistry: node.toolRegistry,
    turnAgent: node.turnAgent,
  };
}

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
