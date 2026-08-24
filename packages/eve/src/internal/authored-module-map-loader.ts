import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  CompiledAgentManifest,
  CompiledAgentNodeManifest,
  CompiledAgentResources,
} from "#compiler/manifest.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import {
  collectModuleRefsForManifest,
  compiledModuleMapSchema,
  type CompiledModuleMap,
} from "#compiler/module-map.js";
import type { RuntimeDiskCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { formatValidationError } from "#runtime/validation.js";
import { loadAuthoredModuleNamespace } from "#internal/authored-module-loader.js";
import { readMaterializedAuthoredModuleIndex } from "#internal/materialized-authored-modules.js";

/**
 * Loads a disk-backed module map by hydrating authored modules directly from
 * source. This is for dev/build flows that need tsconfig alias support and
 * source reloads without relying on Node's module cache for module-map.mjs.
 */
export async function loadCompiledModuleMapFromAuthoredSource(input: {
  readonly compiledArtifactsSource: RuntimeDiskCompiledArtifactsSource;
}): Promise<CompiledModuleMap> {
  const manifest = await loadCompiledManifest({
    compiledArtifactsSource: input.compiledArtifactsSource,
  });

  return await hydrateCompiledModuleMapFromManifest(
    manifest,
    input.compiledArtifactsSource.appRoot,
  );
}

interface ExtensionScopeIndex {
  /** Mount namespace (from `ext:<ns>:` source ids) to package namespace. */
  readonly byMountNamespace: ReadonlyMap<string, string>;
}

async function hydrateCompiledModuleMapFromManifest(
  manifest: CompiledAgentManifest,
  runtimeAppRoot: string,
): Promise<CompiledModuleMap> {
  const materializedIndex = await readMaterializedAuthoredModuleIndex(runtimeAppRoot);
  if (materializedIndex !== undefined) {
    return await loadMaterializedCompiledModuleMap({
      moduleMapPath: materializedIndex.moduleMap,
      runtimeAppRoot,
    });
  }

  const nodes: CompiledModuleMap["nodes"] = {};
  const nodeManifests: Array<{
    additionalModuleRef?: ModuleSourceRef;
    agentRoot: string;
    externalDependencies: readonly string[];
    manifest: CompiledAgentNodeManifest | CompiledAgentResources;
    nodeId: string;
  }> = [
    {
      agentRoot: manifest.agentRoot,
      externalDependencies: manifest.config.build?.externalDependencies ?? [],
      manifest,
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
    },
    ...[...manifest.subagents]
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
      .map((subagent) => ({
        additionalModuleRef: subagent.configResolver,
        agentRoot: subagent.agent.agentRoot,
        externalDependencies:
          subagent.configResolver === undefined
            ? (subagent.agent.config.build?.externalDependencies ?? [])
            : (subagent.configResolver.build?.externalDependencies ?? []),
        manifest: subagent.agent,
        nodeId: subagent.nodeId,
      })),
  ];
  const nodeManifestById = new Map(nodeManifests.map((entry) => [entry.nodeId, entry.manifest]));
  const parentNodeIdByChild = new Map(
    manifest.subagentEdges.map((edge) => [edge.childNodeId, edge.parentNodeId]),
  );
  const extensionNamespacesByNodeId = new Map<string, ReadonlyMap<string, string>>();
  const extensionNamespacesForNode = (nodeId: string): ReadonlyMap<string, string> => {
    const cached = extensionNamespacesByNodeId.get(nodeId);
    if (cached !== undefined) return cached;

    const parentNodeId = parentNodeIdByChild.get(nodeId);
    const namespaces = new Map(
      parentNodeId === undefined ? [] : extensionNamespacesForNode(parentNodeId),
    );
    for (const mount of nodeManifestById.get(nodeId)?.extensionMounts ?? []) {
      namespaces.set(mount.namespace, mount.packageNamespace);
    }
    extensionNamespacesByNodeId.set(nodeId, namespaces);
    return namespaces;
  };

  for (const nodeManifest of nodeManifests) {
    const scopeIndex: ExtensionScopeIndex = {
      byMountNamespace: extensionNamespacesForNode(nodeManifest.nodeId),
    };
    nodes[nodeManifest.nodeId] = {
      modules: await hydrateCompiledNodeScope({
        agentRoot: nodeManifest.agentRoot,
        additionalModuleRef: nodeManifest.additionalModuleRef,
        externalDependencies: nodeManifest.externalDependencies,
        manifest: nodeManifest.manifest,
        scopeIndex,
      }),
    };
  }

  return {
    nodes,
  };
}

async function loadMaterializedCompiledModuleMap(input: {
  readonly moduleMapPath: string;
  readonly runtimeAppRoot: string;
}): Promise<CompiledModuleMap> {
  const moduleMapPath = join(input.runtimeAppRoot, ".eve", "compile", input.moduleMapPath);
  const moduleNamespace = (await import(
    `${pathToFileURL(moduleMapPath).href}?generation=${encodeURIComponent(input.moduleMapPath)}`
  )) as { readonly default?: unknown; readonly moduleMap?: unknown };
  const parsed = compiledModuleMapSchema.safeParse(
    moduleNamespace.moduleMap ?? moduleNamespace.default,
  );

  if (!parsed.success) {
    throw new Error(
      `Expected materialized authored module map "${moduleMapPath}" to export a valid compiled eve module map. ${formatValidationError(parsed.error)}`,
    );
  }

  return parsed.data;
}

/**
 * Resolves the package namespace an extension-owned source id belongs to.
 * Composed sources are keyed `ext:<mountNamespace>:<originalSourceId>`.
 */
function extensionNamespaceForSourceId(
  sourceId: string,
  index: ExtensionScopeIndex,
): string | undefined {
  const match = sourceId.match(/^ext:([^:]+):/);
  return match === null ? undefined : index.byMountNamespace.get(match[1]!);
}

async function hydrateCompiledNodeScope(input: {
  additionalModuleRef?: ModuleSourceRef;
  agentRoot: string;
  externalDependencies: readonly string[];
  manifest: CompiledAgentNodeManifest | CompiledAgentResources;
  scopeIndex: ExtensionScopeIndex;
}): Promise<CompiledModuleMap["nodes"][string]["modules"]> {
  const refs = [
    ...collectModuleRefsForManifest(input.manifest),
    ...(input.additionalModuleRef === undefined ? [] : [input.additionalModuleRef]),
  ].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const modules: CompiledModuleMap["nodes"][string]["modules"] = {};

  for (const ref of refs) {
    const modulePath = join(input.agentRoot, ref.logicalPath);
    const extensionScopeNamespace = extensionNamespaceForSourceId(ref.sourceId, input.scopeIndex);

    modules[ref.sourceId] = await loadAuthoredModuleNamespace(modulePath, {
      externalDependencies: input.externalDependencies,
      extensionScopeNamespace,
    });
  }

  return modules;
}
