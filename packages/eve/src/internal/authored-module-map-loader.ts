import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { CompiledAgentManifest, CompiledAgentNodeManifest } from "#compiler/manifest.js";
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
 * Ambient namespace read by `defineExtension` when it is evaluated from a module
 * the bundler could not scope — specifically a mount's extension package, which
 * resolves cross-package and so loads unbundled in the dev/eval loader. Set only
 * around the synchronous evaluation of one mount module (see below), so it never
 * leaks into consumer code.
 */
const EXT_CONFIG_SCOPE = Symbol.for("eve.ext-config-scope");

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
  /** Mount module source id to package namespace. */
  readonly byMountSourceId: ReadonlyMap<string, string>;
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
    agentRoot: string;
    manifest: CompiledAgentNodeManifest;
    nodeId: string;
  }> = [
    {
      agentRoot: manifest.agentRoot,
      manifest,
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
    },
    ...[...manifest.subagents]
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
      .map((subagent) => ({
        agentRoot: subagent.agent.agentRoot,
        manifest: subagent.agent,
        nodeId: subagent.nodeId,
      })),
  ];

  const scopeIndex: ExtensionScopeIndex = {
    byMountNamespace: new Map(
      manifest.extensionMounts.map((mount) => [mount.namespace, mount.packageNamespace]),
    ),
    byMountSourceId: new Map(
      manifest.extensionMounts.map((mount) => [mount.mountSourceId, mount.packageNamespace]),
    ),
  };
  for (const nodeManifest of nodeManifests) {
    nodes[nodeManifest.nodeId] = {
      modules: await hydrateCompiledNodeScope({
        agentRoot: nodeManifest.agentRoot,
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
  agentRoot: string;
  manifest: CompiledAgentNodeManifest;
  scopeIndex: ExtensionScopeIndex;
}): Promise<CompiledModuleMap["nodes"][string]["modules"]> {
  const refs = collectModuleRefsForManifest(input.manifest).sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId),
  );
  const externalDependencies = input.manifest.config.build?.externalDependencies ?? [];
  const container = globalThis as Record<symbol, unknown>;
  const modules: CompiledModuleMap["nodes"][string]["modules"] = {};

  for (const ref of refs) {
    const modulePath = join(input.agentRoot, ref.logicalPath);
    const extensionScopeNamespace = extensionNamespaceForSourceId(ref.sourceId, input.scopeIndex);

    // A mount module (e.g. `agent/extensions/crm.ts`) imports the extension
    // package cross-package, so its config handle loads unbundled and the
    // bundler cannot scope it. Set the ambient config scope around this one
    // synchronous load so the mount's `defineExtension` binds under the package
    // namespace — matching what the extension's own bundled tools read.
    const mountConfigScope = input.scopeIndex.byMountSourceId.get(ref.sourceId);
    if (mountConfigScope !== undefined) {
      container[EXT_CONFIG_SCOPE] = mountConfigScope;
    }
    try {
      modules[ref.sourceId] = await loadAuthoredModuleNamespace(modulePath, {
        externalDependencies,
        extensionScopeNamespace,
      });
    } finally {
      if (mountConfigScope !== undefined) {
        container[EXT_CONFIG_SCOPE] = undefined;
      }
    }
  }

  return modules;
}
