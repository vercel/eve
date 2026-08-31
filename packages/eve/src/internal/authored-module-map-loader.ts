import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  CompiledAgentManifest,
  CompiledAgentNodeManifest,
  CompiledAgentResources,
} from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { memoizeModuleNamespaceFactories } from "#compiler/source-graph.js";
import {
  collectRuntimeModuleBindingsForManifest,
  compiledModuleMapSchema,
  resolveCompiledModuleExtensionScopeNamespace,
  type CompiledModuleMap,
} from "#compiler/module-map.js";
import { loadFrameworkProgrammaticModule } from "#framework/sources/registry.js";
import { loadAuthoredModuleNamespace } from "#internal/authored-module-loader.js";
import { readMaterializedAuthoredModuleIndex } from "#internal/materialized-authored-modules.js";
import type { RuntimeDiskCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { formatValidationError } from "#runtime/validation.js";

const EXT_CONFIG_SCOPE = Symbol.for("eve.ext-config-scope");

/** Hydrates the compiled module map from the exact physical bindings in the manifest. */
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
  const nodeManifests: ReadonlyArray<{
    readonly manifest: CompiledAgentNodeManifest | CompiledAgentResources;
    readonly nodeId: string;
  }> = [
    { manifest, nodeId: ROOT_COMPILED_AGENT_NODE_ID },
    ...[...manifest.subagents]
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
      .map((subagent) => ({ manifest: subagent.agent, nodeId: subagent.nodeId })),
  ];
  for (const node of nodeManifests) {
    nodes[node.nodeId] = {
      modules: await hydrateCompiledNodeScope(node.manifest),
    };
  }
  return { nodes };
}

async function hydrateCompiledNodeScope(
  manifest: CompiledAgentNodeManifest | CompiledAgentResources,
): Promise<CompiledModuleMap["nodes"][string]["modules"]> {
  const mountScopes = new Map(
    manifest.extensionMounts.map((mount) => [mount.mountSourceId, mount.packageNamespace]),
  );
  const container = globalThis as Record<symbol, unknown>;
  const modules: CompiledModuleMap["nodes"][string]["modules"] = {};
  for (const { binding, sourceId } of collectRuntimeModuleBindingsForManifest(manifest)) {
    const mountConfigScope = mountScopes.get(sourceId);
    if (mountConfigScope !== undefined) container[EXT_CONFIG_SCOPE] = mountConfigScope;
    try {
      modules[sourceId] =
        binding.backing.kind === "programmatic"
          ? await loadFrameworkProgrammaticModule(
              binding.backing,
              Object.fromEntries(
                Object.entries(binding.backing.dependencies ?? {}).map(
                  ([alias, dependencySourceId]) => [alias, modules[dependencySourceId]!],
                ),
              ),
            )
          : memoizeModuleNamespaceFactories(
              await loadAuthoredModuleNamespace(binding.backing.sourcePath, {
                externalDependencies: binding.backing.externalDependencies,
                extensionScopeNamespace: resolveCompiledModuleExtensionScopeNamespace(binding),
              }),
            );
    } finally {
      if (mountConfigScope !== undefined) container[EXT_CONFIG_SCOPE] = undefined;
    }
  }
  return modules;
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
